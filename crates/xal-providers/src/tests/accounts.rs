use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

fn tokens() -> Value {
    json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600,"id_token":format!("header.{}.signature", URL_SAFE_NO_PAD.encode(json!({"chatgpt_account_id":"fixture-account"}).to_string()))})
}

#[tokio::test]
async fn oauth_expiry_round_trips_without_false_credential_changes() {
    for fraction in 0..4096 {
        let original = crate::auth::credential(
            Id::ChatGpt,
            &tokens(),
            None,
            1_780_000_000_000.0 + f64::from(fraction) / 4096.0,
        )
        .unwrap();
        let encoded = serde_json::to_string(&original).unwrap();
        let parsed = Credential::parse(&serde_json::from_str(&encoded).unwrap()).unwrap();
        assert!(
            original == parsed,
            "expiry changed at fractional millisecond {fraction}/4096"
        );
    }
    let home = Directory::new();
    let original = crate::auth::credential(
        Id::ChatGpt,
        &tokens(),
        None,
        1_780_000_000_000.0 + 6.0 / 4096.0,
    )
    .unwrap();
    let profile = profiles::update(
        &home.0,
        Change::Create {
            name: "Chat".into(),
            provider: "openai-chatgpt".into(),
            credential: original.clone(),
        },
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let stored = Credentials::load(&home.0.join("credentials.json")).unwrap();
    assert!(stored.credential("openai-chatgpt", &profile.id).unwrap() == Some(&original));
    let next = crate::auth::credential(
        Id::ChatGpt,
        &tokens(),
        Some(&original),
        1_780_000_000_000.0 + 7.0 / 4096.0,
    )
    .unwrap();
    profiles::update(
        &home.0,
        Change::Replace {
            provider: "openai-chatgpt".into(),
            id: profile.id.clone(),
            expected: original,
            credential: next.clone(),
        },
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let stored = Credentials::load(&home.0.join("credentials.json")).unwrap();
    assert!(stored.credential("openai-chatgpt", &profile.id).unwrap() == Some(&next));
}

#[tokio::test]
async fn browser_pkce_pasted_callbacks_and_loopback_state_are_validated() {
    let server = Server::new(vec![(200, tokens().to_string(), Duration::ZERO)]).await;
    let mut connection = client(Id::ChatGpt);
    connection.auth_endpoint = Some(server.url.clone());
    let flow = connection.browser_start().unwrap();
    let url = reqwest13::Url::parse(&flow.url).unwrap();
    let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(
        flow.code("http://localhost:1455/auth/callback?code=code&state=wrong")
            .is_err()
    );
    assert!(flow.code(&format!("code#{}", query["state"])).is_ok());
    assert!(
        flow.code(&format!(
            "http://localhost:1455/auth/callback?error=access_denied&state={}",
            query["state"]
        ))
        .is_err()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancel = Cancellation::default();
    let driver = async {
        for (state, status) in [("wrong", "400"), (query["state"].as_str(), "200")] {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(format!("GET /auth/callback?code=authorization-code&state={state} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).await.unwrap();
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")));
        }
    };
    let (callback, ()) = tokio::join!(crate::auth::callback(listener, &flow, &cancel), driver);
    let credential = connection
        .browser_finish(flow, &callback.unwrap(), &cancel)
        .await
        .unwrap();
    assert!(
        matches!(credential, Credential::OAuth { account_id: Some(ref id), .. } if id == "fixture-account")
    );
    let requests = server.requests.lock().unwrap();
    let form: BTreeMap<_, _> =
        reqwest13::Url::parse(&format!("https://fixture.invalid/?{}", requests[0].1))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
    assert_eq!(form["code"], "authorization-code");
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes())),
        query["code_challenge"]
    );
    assert!(
        !connection
            .redactor
            .redact(&format!(
                "{} rotated-access authorization-code",
                form["code_verifier"]
            ))
            .contains("rotated-access")
    );
}

#[tokio::test]
async fn device_accounts_handle_pending_slow_down_exchange_and_denial() {
    for id in [Id::ChatGpt, Id::Xai, Id::Copilot] {
        let mut replies = vec![];
        if id == Id::ChatGpt {
            replies.push((403, "not JSON".into(), Duration::ZERO));
            replies.push((200, json!({"authorization_code":"device-authorization","code_verifier":"device-verifier"}).to_string(), Duration::ZERO));
        } else {
            replies.push((
                200,
                json!({"error":"authorization_pending"}).to_string(),
                Duration::ZERO,
            ));
            if id == Id::Xai {
                replies.push((
                    200,
                    json!({"error":"slow_down","interval":0.001}).to_string(),
                    Duration::ZERO,
                ));
            }
        }
        replies.push((200, tokens().to_string(), Duration::ZERO));
        let server = Server::new(replies).await;
        let mut connection = client(id);
        connection.auth_endpoint = Some(server.url.clone());
        let device = crate::auth::Device::parse(id, &json!({"device_code":"device","device_auth_id":"device","user_code":"USER","verification_uri":"https://fixture.invalid/device","interval":0.001,"expires_in":30})).unwrap();
        let credential = connection
            .device_finish(device, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(
            matches!(credential, Credential::ApiKey { .. }),
            id == Id::Copilot
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), if id == Id::Copilot { 2 } else { 3 });
        if id == Id::ChatGpt {
            assert!(requests[2].1.contains("device-verifier"));
        }
    }
    for error in ["access_denied", "expired_token"] {
        let server = Server::new(vec![(
            400,
            json!({"error":error}).to_string(),
            Duration::ZERO,
        )])
        .await;
        let mut connection = client(Id::Xai);
        connection.auth_endpoint = Some(server.url.clone());
        let raw = json!({"device_code":"device","user_code":"USER","verification_uri":"https://fixture.invalid/device","interval":0.001,"expires_in":30});
        assert!(
            connection
                .device_finish(
                    crate::auth::Device::parse(Id::Xai, &raw).unwrap(),
                    &Cancellation::default()
                )
                .await
                .is_err()
        );
    }
    let connection = client(Id::Xai);
    let raw = json!({"device_code":"device","user_code":"USER","verification_uri":"https://fixture.invalid/device","interval":1,"expires_in":0.001});
    assert!(
        connection
            .device_finish(
                crate::auth::Device::parse(Id::Xai, &raw).unwrap(),
                &Cancellation::default()
            )
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("timed out")
    );
}

#[tokio::test]
async fn catalog_refresh_uses_rotated_credentials_and_retains_its_fallback() {
    for expired in [false, true] {
        let home = Directory::new();
        let profile = profiles::update(
            &home.0,
            Change::Create {
                name: "Chat".into(),
                provider: "openai-chatgpt".into(),
                credential: Credential::OAuth {
                    access: "old-access".into(),
                    refresh: "old-refresh".into(),
                    expires: if expired { 0.0 } else { 9_000_000_000_000.0 },
                    account_id: Some("fixture-account".into()),
                },
            },
            &Cancellation::default(),
        )
        .await
        .unwrap();
        storage::write_json(
            &home
                .0
                .join(format!("cache/openai-chatgpt-models-{}.json", profile.id)),
            &json!({"models":[{"id":"cached","name":"Cached","supportsFast":false}]}),
        )
        .unwrap();
        let auth = Server::new(vec![(200, tokens().to_string(), Duration::ZERO)]).await;
        let server = Server::new(if expired { vec![(503,"{}".into(),Duration::ZERO)] } else { vec![(401,"{}".into(),Duration::ZERO),(200,json!({"models":[{"slug":"gpt-5.6","display_name":"Model","visibility":"list","additional_speed_tiers":["fast"]}]}).to_string(),Duration::ZERO)] }).await;
        let mut connection = Client::new(
            Id::ChatGpt,
            Account::Profile {
                home: home.0.clone(),
                id: profile.id.clone(),
            },
            &settings(),
            Arc::new(Redactor::new(Vec::new()).unwrap()),
        )
        .unwrap();
        connection.endpoint = server.url.clone();
        connection.auth_endpoint = Some(auth.url.clone());
        let catalog = connection
            .catalog(&home.0, &profile.id, true, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(catalog.source, if expired { "cache" } else { "runtime" });
        assert_eq!(auth.requests.lock().unwrap().len(), 1);
        let requests = server.requests.lock().unwrap();
        assert!(
            requests
                .last()
                .unwrap()
                .0
                .contains("authorization: Bearer rotated-access")
        );
        assert!(
            requests
                .last()
                .unwrap()
                .0
                .contains("chatgpt-account-id: fixture-account")
        );
    }
}

#[tokio::test]
async fn refresh_cas_never_resurrects_disconnected_or_replaced_accounts() {
    for action in ["rename", "delete", "replace"] {
        let home = Directory::new();
        let original = Credential::OAuth {
            access: "old-access".into(),
            refresh: "old-refresh".into(),
            expires: 0.0,
            account_id: None,
        };
        let profile = profiles::update(
            &home.0,
            Change::Create {
                name: "Original".into(),
                provider: "xai".into(),
                credential: original.clone(),
            },
            &Cancellation::default(),
        )
        .await
        .unwrap();
        let server = Server::new(vec![(
            200,
            tokens().to_string(),
            Duration::from_millis(100),
        )])
        .await;
        let mut connection = Client::new(
            Id::Xai,
            Account::Profile {
                home: home.0.clone(),
                id: profile.id.clone(),
            },
            &settings(),
            Arc::new(Redactor::new(Vec::new()).unwrap()),
        )
        .unwrap();
        connection.auth_endpoint = Some(server.url.clone());
        let cancel = Cancellation::default();
        let mut operation = Box::pin(connection.credential(false, &cancel));
        tokio::select! { _ = &mut operation => panic!("refresh ended before mutation"), () = server.wait_for(1) => {} }
        let change = match action {
            "rename" => Change::Rename {
                id: profile.id.clone(),
                name: "Renamed".into(),
            },
            "delete" => Change::Delete {
                id: profile.id.clone(),
            },
            _ => Change::Replace {
                provider: "xai".into(),
                id: profile.id.clone(),
                expected: original,
                credential: Credential::ApiKey {
                    key: "replacement".into(),
                },
            },
        };
        profiles::update(&home.0, change, &cancel).await.unwrap();
        assert_eq!(operation.await.is_ok(), action == "rename");
        let stored = Credentials::load(&home.0.join("credentials.json")).unwrap();
        match action {
            "rename" => {
                assert_eq!(stored.profiles()[0].name, "Renamed");
                assert!(
                    matches!(stored.credential("xai",&profile.id).unwrap(),Some(Credential::OAuth{access,..}) if access == "rotated-access")
                );
            }
            "delete" => assert!(stored.profiles().is_empty()),
            _ => assert!(
                matches!(stored.credential("xai",&profile.id).unwrap(),Some(Credential::ApiKey{key}) if key == "replacement")
            ),
        }
    }
}

#[tokio::test]
async fn catalog_fallback_revalidates_account_binding_after_discovery() {
    let home = Directory::new();
    let path = home.0.join("cache/github-copilot-models-fixture.json");
    let models = catalog::parse_models(Id::Copilot, &json!({"data":[{"id":"model","name":"Model","model_picker_enabled":true,"supported_endpoints":["/responses"]}]}), true, 260000).unwrap();
    storage::write_json(&path, &json!({"version":3,"domain":"github.com","credentialId":URL_SAFE_NO_PAD.encode(Sha256::digest(b"fixture-key")),"models":models})).unwrap();
    let server = Server::new(vec![(503, "{}".into(), Duration::from_millis(100))]).await;
    let mut connection = client(Id::Copilot);
    connection.endpoint = server.url.clone();
    let cancel = Cancellation::default();
    let mut operation = Box::pin(connection.catalog(&home.0, "fixture", true, &cancel));
    tokio::select! { _ = &mut operation => panic!("discovery finished before cache replacement"), () = server.wait_for(1) => {} }
    storage::write_json(&path, &json!({"version":3,"domain":"github.com","credentialId":URL_SAFE_NO_PAD.encode(Sha256::digest(b"replaced-key")),"models":models})).unwrap();
    assert!(
        operation
            .await
            .unwrap_err()
            .to_string()
            .contains("no validated cache")
    );
}

#[test]
fn legacy_alias_preferences_and_xai_reasoning_keep_their_contracts() {
    let settings=Settings::parse(json!({"contextWindows":{"openai-chatgpt":{"gpt-5.6":400000,"gpt-5.6-fast":800000}},"compactionLimits":{"openai-chatgpt":{"gpt-5.6":200000}}}).as_object().unwrap()).unwrap();
    let models=catalog::parse_models(Id::ChatGpt,&json!({"models":[{"slug":"gpt-5.6","display_name":"Model","visibility":"list","context_window":260000,"max_context_window":1000000,"additional_speed_tiers":["fast"]}]}),true,260000).unwrap();
    let normal =
        catalog::configured(Id::ChatGpt, &models, "gpt-5.6-1m", 260000, &settings).unwrap();
    assert_eq!(normal.context_window, Some(400000));
    assert_eq!(normal.auto_compact_token_limit, Some(200000));
    let fast =
        catalog::configured(Id::ChatGpt, &models, "gpt-5.6-1m-fast", 260000, &settings).unwrap();
    assert_eq!(fast.context_window, Some(800000));
    assert!(
        matches!(responses::event(Id::Xai,&json!({"type":"response.reasoning_text.delta","delta":"plan"}).to_string(),"grok").unwrap(),Some(ProviderEvent::ReasoningSummaryDelta(s)) if s == "plan")
    );
}

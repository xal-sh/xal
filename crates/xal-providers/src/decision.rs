use serde_json::Value;
use xal_host::*;

use crate::{Id, client::Client, count, failure, invalid, string};

pub fn handler(client: Client) -> Handler<DecisionRequest, DecisionResponse> {
    Box::new(move |request, context| {
        let client = client.clone();
        Box::pin(async move {
            client
                .evaluate(
                    request,
                    &context.cancellation,
                    context.observation.as_deref(),
                )
                .await
        })
    })
}

impl Client {
    pub async fn evaluate(
        &self,
        request: DecisionRequest,
        cancel: &Cancellation,
        observation: Option<&recording::Request>,
    ) -> Result<DecisionResponse> {
        if self.id != Id::TypeSafe {
            return Err(invalid("provider does not support decisions"));
        }
        xal_host::decisions::validate(&request)?;
        let body = serde_json::to_value(&request).map_err(failure)?;
        let operation = async {
            let response = self
                .request("/systemone", Some(&body), None, cancel)
                .await?;
            let raw = xal_services::transport::json(response, 8 * 1024 * 1024)
                .await
                .map_err(failure)?;
            if let Some(observation) = observation {
                let usage = usage(&raw)?;
                if usage.total_input_tokens.is_some() || usage.output_tokens.is_some() {
                    observation.usage(usage)?;
                }
            }
            parse(&request, raw)
        };
        tokio::select! { biased; () = cancel.cancelled() => Err(Error::Cancelled), result = operation => result }
    }
}

fn usage(raw: &Value) -> Result<Usage> {
    Ok(Usage {
        total_input_tokens: count(raw.pointer("/usage/input_tokens"))?,
        output_tokens: count(raw.pointer("/usage/output_tokens"))?,
        ..Usage::default()
    })
}

pub fn parse(request: &DecisionRequest, raw: Value) -> Result<DecisionResponse> {
    let response = DecisionResponse {
        model: string(&raw, "model")?.into(),
        answers: serde_json::from_value(
            raw.get("answers")
                .cloned()
                .ok_or_else(|| invalid("decision response has no answers"))?,
        )
        .map_err(|_| invalid("invalid decision answers"))?,
        usage: usage(&raw)?,
    };
    xal_host::decisions::validate_response(request, &response)?;
    Ok(response)
}

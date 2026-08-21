use super::*;

fn internal_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
                || address.is_multicast()
                || octets[0] >= 240
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || address.is_multicast()
                || address
                    .to_ipv4()
                    .is_some_and(|address| internal_address(IpAddr::V4(address)))
        }
    }
}

pub(super) async fn resolve_target(url: &reqwest13::Url) -> napi::Result<Vec<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or_else(|| invalid(format!("URL has no host: {url}")))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid(format!("URL has no port: {url}")))?;
    let host = host.to_owned();
    let addresses = tokio::time::timeout(
        Duration::from_secs(TIMEOUT_SECONDS),
        tokio::task::spawn_blocking(move || {
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect::<Vec<_>>())
        }),
    )
    .await
    .map_err(|_| {
        failed(format!(
            "DNS lookup timed out after {TIMEOUT_SECONDS} seconds: {url}"
        ))
    })?
    .map_err(|error| failed(error.to_string()))?
    .map_err(|error| failed(error.to_string()))?;
    if addresses.is_empty() {
        return Err(failed(format!("URL host did not resolve: {url}")));
    }
    if addresses
        .iter()
        .any(|address| internal_address(address.ip()))
    {
        return Err(invalid(format!(
            "URL resolves to an internal address: {url}"
        )));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::internal_address;

    #[test]
    fn blocks_ipv4_compatible_internal_ipv6_addresses() {
        assert!(internal_address("::127.0.0.1".parse().unwrap()));
        assert!(internal_address("::10.0.0.1".parse().unwrap()));
    }
}

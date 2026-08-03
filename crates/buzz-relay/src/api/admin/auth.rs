use axum::http::{header, HeaderMap};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use super::error::ApiError;
use crate::config::{AdminAuth, AdminConfig, AdminToken};
use crate::state::AppState;

/// Scope constant for the admin NIP-98 replay guard. Deployment-global, like
/// the operator-management scope in `api/operator.rs`.
const ADMIN_REPLAY_SCOPE: &str = "admin-moderation";

/// The API prefix under which the admin routes are mounted in the relay router.
/// NIP-98 clients sign the full URL (`https://admin.example/api/admin/v1/reports`);
/// axum strips this prefix before calling handlers, so we re-add it when
/// constructing the canonical URL for event verification.
pub(crate) const ADMIN_API_PREFIX: &str = "/api/admin/v1";

pub(crate) fn is_admin_host(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(config) = state.config.admin.as_ref() else {
        return false;
    };
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == config.host)
}

/// Derive the canonical URL for a NIP-98 `u`-tag check.
///
/// Scheme: `https://` unless the host is a loopback address (localhost or
/// 127.x.x.x), in which case `http://` is used — matching local dev via
/// the Justfile.
fn canonical_url(host: &str, path: &str) -> String {
    let host_part = host.split(':').next().unwrap_or(host);
    let is_loopback =
        host_part == "localhost" || host_part == "::1" || host_part.starts_with("127.");
    let scheme = if is_loopback { "http" } else { "https" };
    format!("{scheme}://{host}{path}")
}

/// `path_and_query` is the full request target including any query string
/// (e.g. `/reports?status=open&limit=100`). NIP-98 clients sign the full URL;
/// passing only `uri.path()` causes every query-bearing request to fail auth.
pub async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    path_and_query: &str,
) -> Result<(), ApiError> {
    let config = state
        .config
        .admin
        .as_ref()
        .ok_or_else(ApiError::not_found)?;
    // Credential first: an unauthenticated caller learns nothing about which
    // Host or Origin the deployment expects.
    match &config.auth {
        AdminAuth::Token(token) => authorize_bearer(token, headers)?,
        AdminAuth::Disabled => {}
        AdminAuth::Nip98 { pubkeys } => {
            // Prefix the handler-received path+query with the mounted prefix so
            // the canonical URL matches what NIP-98 clients signed (the full URL
            // as seen in the browser, e.g.
            // /api/admin/v1/reports?status=open&limit=100).
            let full_path = format!("{ADMIN_API_PREFIX}{path_and_query}");
            authorize_nip98(state, config, headers, &full_path, pubkeys).await?;
        }
    }
    if !is_admin_host(state, headers) {
        return Err(ApiError::forbidden());
    }
    if headers.get(header::ORIGIN).is_some_and(|origin| {
        origin
            .to_str()
            .map_or(true, |origin| !origin_matches_host(origin, &config.host))
    }) {
        return Err(ApiError::forbidden());
    }
    Ok(())
}

/// Require exactly one `Authorization: Bearer <64 hex>` header matching the
/// configured operator token. Every rejection is the same 401 envelope.
fn authorize_bearer(token: &AdminToken, headers: &HeaderMap) -> Result<(), ApiError> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return Err(ApiError::unauthorized());
    };
    let credential = value
        .to_str()
        .ok()
        .and_then(bearer_credential)
        .ok_or_else(ApiError::unauthorized)?;
    // Length and hex shape are public facts about the credential format, so
    // rejecting them early leaks nothing; only the value compare must be
    // constant-time.
    let mut presented = [0u8; 32];
    hex::decode_to_slice(credential, &mut presented)
        .map_err(|_| ApiError::unauthorized())
        .and_then(|()| {
            token
                .matches(&presented)
                .then_some(())
                .ok_or_else(ApiError::unauthorized)
        })
}

/// Require exactly one `Authorization: Nostr <base64 event>` header, verify
/// the NIP-98 event, check the replay guard, and check the pubkey allowlist.
/// Uniform 401 on any auth failure — no oracle distinguishing the failure mode.
async fn authorize_nip98(
    state: &AppState,
    config: &AdminConfig,
    headers: &HeaderMap,
    path: &str,
    pubkeys: &[String],
) -> Result<(), ApiError> {
    // All 401s in nip98 mode advertise the Nostr scheme.
    let unauth = || ApiError::unauthorized().with_www_authenticate("Nostr");

    // 1. Extract exactly one Authorization: Nostr header.
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        return Err(unauth());
    };
    let auth_str = value
        .to_str()
        .ok()
        .and_then(nostr_credential)
        .ok_or_else(unauth)?;

    // 2. Base64-decode and parse as JSON.
    let event_json = {
        let bytes = BASE64.decode(auth_str).map_err(|_| unauth())?;
        String::from_utf8(bytes).map_err(|_| unauth())?
    };
    let event: nostr::Event = serde_json::from_str(&event_json).map_err(|_| unauth())?;
    let event_id_bytes = event.id.to_bytes();

    // 3. Derive the expected URL from CONFIG, not the inbound Host header.
    let url = canonical_url(&config.host, path);

    // 4. Verify signature, timestamp, u-tag, method-tag (no body for GET).
    let pubkey =
        buzz_auth::verify_nip98_event(&event_json, &url, "GET", None).map_err(|_| unauth())?;

    // 5. Replay guard — deployment-scoped, fail-closed.
    let event_id = nostr::EventId::from_byte_array(event_id_bytes);
    match state
        .nip98_replay
        .try_mark_in_scope(
            ADMIN_REPLAY_SCOPE,
            &event_id,
            buzz_auth::DEFAULT_REPLAY_TTL_SECS,
        )
        .await
    {
        Ok(true) => {}
        Ok(false) => return Err(unauth()),
        Err(err) => {
            tracing::warn!(
                scope = ADMIN_REPLAY_SCOPE,
                error = %err,
                "admin NIP-98 replay guard failed; rejecting request fail-closed"
            );
            return Err(unauth());
        }
    }

    // 6. Allowlist check.
    let pubkey_hex = pubkey.to_hex();
    if !pubkeys.iter().any(|pk| pk == &pubkey_hex) {
        return Err(unauth());
    }

    Ok(())
}

/// Extract the credential from an `Authorization: Nostr <base64>` value.
fn nostr_credential(value: &str) -> Option<&str> {
    let (scheme, credential) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("Nostr")
        .then(|| credential.trim_start_matches(' '))
        .filter(|c| !c.is_empty())
}

/// Extract the credential from an `Authorization` value. RFC 9110 makes the
/// auth scheme case-insensitive, so `bearer` is as valid as `Bearer`.
fn bearer_credential(value: &str) -> Option<&str> {
    let (scheme, credential) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("Bearer")
        .then(|| credential.trim_start_matches(' '))
        .filter(|credential| !credential.is_empty())
}

fn origin_matches_host(origin: &str, host: &str) -> bool {
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        == Some(host)
}

#[cfg(test)]
mod tests {
    use super::{bearer_credential, canonical_url, nostr_credential, origin_matches_host};

    #[test]
    fn browser_origin_must_match_admin_host() {
        assert!(origin_matches_host(
            "https://admin.example.com",
            "admin.example.com"
        ));
        assert!(origin_matches_host(
            "http://admin.localhost:3000",
            "admin.localhost:3000"
        ));
        assert!(!origin_matches_host(
            "https://attacker.example",
            "admin.example.com"
        ));
        assert!(!origin_matches_host("null", "admin.example.com"));
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_and_credential_is_non_empty() {
        assert_eq!(bearer_credential("Bearer abc"), Some("abc"));
        assert_eq!(bearer_credential("bearer abc"), Some("abc"));
        assert_eq!(bearer_credential("BEARER  abc"), Some("abc"));
        assert_eq!(bearer_credential("Bearer "), None);
        assert_eq!(bearer_credential("Basic abc"), None);
        assert_eq!(bearer_credential("abc"), None);
        assert_eq!(bearer_credential(""), None);
    }

    #[test]
    fn nostr_credential_is_case_insensitive_and_non_empty() {
        assert_eq!(nostr_credential("Nostr abc"), Some("abc"));
        assert_eq!(nostr_credential("nostr abc"), Some("abc"));
        assert_eq!(nostr_credential("NOSTR  abc"), Some("abc"));
        assert_eq!(nostr_credential("Nostr "), None);
        assert_eq!(nostr_credential("Bearer abc"), None);
        assert_eq!(nostr_credential("abc"), None);
    }

    #[test]
    fn canonical_url_uses_https_for_non_loopback_hosts() {
        assert_eq!(
            canonical_url("admin.example.com", "/api/admin/v1/reports"),
            "https://admin.example.com/api/admin/v1/reports"
        );
        assert_eq!(
            canonical_url("admin.example.com:8443", "/path"),
            "https://admin.example.com:8443/path"
        );
    }

    #[test]
    fn canonical_url_uses_http_for_loopback_hosts() {
        assert_eq!(
            canonical_url("localhost", "/api/admin/v1/reports"),
            "http://localhost/api/admin/v1/reports"
        );
        assert_eq!(
            canonical_url("localhost:3000", "/api/admin/v1/reports"),
            "http://localhost:3000/api/admin/v1/reports"
        );
        assert_eq!(
            canonical_url("127.0.0.1:3000", "/path"),
            "http://127.0.0.1:3000/path"
        );
        assert_eq!(canonical_url("127.0.0.1", "/path"), "http://127.0.0.1/path");
    }
}

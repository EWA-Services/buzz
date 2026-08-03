use tauri::Emitter;

use crate::{app_state::AppState, relay::classify_request_error};

pub(super) async fn send_upload_attempt(
    state: &AppState,
    url: String,
    auth_header: &str,
    mime: &str,
    sha256: &str,
    body: bytes::Bytes,
    progress: Option<&(tauri::AppHandle, String)>,
) -> Result<reqwest::Response, String> {
    let req = state
        .http_client
        .put(url)
        .header("Authorization", auth_header)
        .header("Content-Type", mime)
        .header("X-SHA-256", sha256);

    let response = if let Some((app, progress_id)) = progress {
        let app = app.clone();
        let progress_id = progress_id.clone();
        let total = body.len() as u64;
        let chunk_size = 64 * 1024;
        let chunk_count = body.len().div_ceil(chunk_size);
        let mut sent: u64 = 0;
        let stream = futures_util::stream::iter((0..chunk_count).map(move |i| {
            let start = i * chunk_size;
            let end = usize::min(start + chunk_size, body.len());
            let chunk = body.slice(start..end);
            sent += chunk.len() as u64;
            let _ = app.emit(
                "media-upload-progress",
                serde_json::json!({ "id": progress_id, "sent": sent, "total": total }),
            );
            Ok::<bytes::Bytes, std::io::Error>(chunk)
        }));
        req.header(reqwest::header::CONTENT_LENGTH, total)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
    } else {
        req.body(body).send().await
    };
    response.map_err(|error| classify_request_error(&error))
}

pub(super) fn emit_media_upload_phase(
    app: &tauri::AppHandle,
    progress_id: Option<&str>,
    phase: &'static str,
) {
    let Some(id) = progress_id else {
        return;
    };
    let _ = app.emit(
        "media-upload-phase",
        serde_json::json!({ "id": id, "phase": phase }),
    );
}

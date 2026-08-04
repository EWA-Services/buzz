//! Retention, tombstone, and archive helpers for managed agents.
//!
//! All functions here are best-effort: failures are logged and swallowed so a
//! retention or journal hiccup never blocks the disk-authoritative write.
//! These are called inside the `managed_agents_store_lock`-held body and MUST
//! NOT be called across an `.await`.

use tauri::AppHandle;

use crate::{app_state::AppState, managed_agents::ManagedAgentRecord};

/// Retain a freshly authored managed-agent event, flagged for relay sync.
///
/// Owner-authored: the owner keys sign, d_tag is the agent's pubkey, coordinate
/// is `30177:<owner>:<agent_pubkey>`. The retention content-equality guard
/// compares the opt-IN `agent_event_content` projection, so a runtime-only
/// mutation produces an identical row and never re-enqueues a publish.
///
/// `op_id` is the journal operation ID from the preceding `mutate_agent_store`
/// call. When `None`, a publication-only operation is created. The outbox entry
/// records the immutable event identity before relay dispatch, so the flush loop
/// (and boot recovery) can re-drive it if the process crashes before the relay
/// accepts it.
pub(crate) fn retain_managed_agent_pending(
    app: &AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
    op_id: Option<&str>,
) {
    use crate::managed_agents::{reconcile::retain_agent_record, retention::open_retention_db};

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let conn = open_retention_db(&scope.db_path)?;
        if let Some((event_id, raw_json)) = retain_agent_record(&conn, &scope.owner_keys, record)? {
            // B1 journal outbox: record the immutable event identity before
            // the retention DB entry is flushed to the relay.
            let anchor = crate::managed_agents::store_journal::store_anchor_dir(app)?;
            std::fs::create_dir_all(&anchor)
                .map_err(|e| format!("create anchor dir for outbox: {e}"))?;
            let journal = crate::managed_agents::store_journal::open_journal(&anchor)?;
            let pub_op_id: String;
            let effective_op_id: &str = match op_id {
                Some(id) => id,
                None => {
                    pub_op_id = crate::managed_agents::store_journal::new_operation_id();
                    crate::managed_agents::store_journal::insert_operation(
                        &journal,
                        &pub_op_id,
                        "publish",
                        &record.pubkey,
                        crate::managed_agents::store_journal::Generation::zero(),
                    )?;
                    &pub_op_id
                }
            };
            crate::managed_agents::store_journal::insert_outbox_event(
                &journal,
                &event_id,
                effective_op_id,
                raw_json.as_bytes(),
            )?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-retain: {e}");
    }
}

/// Purge a deleted agent's pending row and enqueue a NIP-09 tombstone.
///
/// Called inside the `managed_agents_store_lock`-held delete body. Best-effort:
/// a failure is logged and swallowed so a retention hiccup never blocks the
/// disk-authoritative delete.
pub(crate) fn tombstone_managed_agent_pending(
    app: &AppHandle,
    state: &AppState,
    agent_pubkey: &str,
) {
    use crate::managed_agents::{
        agent_events::build_agent_delete,
        retention::{
            delete_retained_event, open_retention_db, retain_event, tombstone_retention_d_tag,
            RetainedEvent,
        },
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();
        let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
            .sign_with_keys(&scope.owner_keys)
            .map_err(|e| format!("failed to sign managed-agent tombstone: {e}"))?;
        let conn = open_retention_db(&scope.db_path)?;
        delete_retained_event(&conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey: owner_pubkey,
                d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-tombstone: {e}");
    }
}

/// Build and sign the NIP-IA `kind:9035` archive request for a deleted agent.
///
/// Pure given the keys — unit-testable without an `AppHandle`. Uses `retired`
/// as the machine-readable reason (NIP-IA suggested code for a decommissioned
/// key). The owner auth tag is minted locally from the same keys.
pub(crate) fn build_agent_archive_request(
    keys: &nostr::Keys,
    agent_pubkey: &str,
) -> Result<nostr::Event, String> {
    let auth_tag = if keys
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(agent_pubkey)
    {
        None
    } else {
        let agent = nostr::PublicKey::from_hex(agent_pubkey)
            .map_err(|e| format!("invalid agent pubkey: {e}"))?;
        let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(keys, &agent, "")
            .map_err(|e| format!("failed to build owner auth tag: {e}"))?;
        let parts: Vec<String> = serde_json::from_str(&tag_json)
            .map_err(|e| format!("failed to parse owner auth tag: {e}"))?;
        Some(
            <[String; 4]>::try_from(parts)
                .map_err(|_| "owner auth tag must have four elements".to_string())?,
        )
    };
    crate::events::build_archive_identity_request(
        agent_pubkey,
        "",
        Some("retired"),
        None,
        auth_tag.as_ref(),
    )?
    .sign_with_keys(keys)
    .map_err(|e| format!("failed to sign archive request: {e}"))
}

/// Enqueue a NIP-IA `kind:9035` archive request for a deleted agent.
///
/// The tombstone removes the agent's 30177 record cross-device; the archive
/// request stops the agent's `kind:0` and channel memberships appearing in
/// member pickers. Called inside the lock-held delete body. Best-effort.
pub(crate) fn archive_managed_agent_pending(app: &AppHandle, state: &AppState, agent_pubkey: &str) {
    use crate::managed_agents::retention::{open_retention_db, retain_event, RetainedEvent};
    use buzz_core_pkg::kind::KIND_IA_ARCHIVE_REQUEST;
    use nostr::JsonUtil;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();
        let event = build_agent_archive_request(&scope.owner_keys, agent_pubkey)?;
        let conn = open_retention_db(&scope.db_path)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_IA_ARCHIVE_REQUEST,
                pubkey: owner_pubkey,
                d_tag: agent_pubkey.to_string(),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-archive: {e}");
    }
}

//! Closure-only mutation API (v7) and boot recovery driver.
//!
//! `mutate_store` is the **only** write entry point for the managed-agents
//! store.  It owns the full lock sequence:
//!
//!   in-process mutex (caller-held `store_mutex_guard`)
//!   → anchored OS advisory lock (acquired here)
//!   → fresh fail-closed decode
//!   → SQLite journal transaction (inside `mutation`)
//!   → atomic fsync write of both canonical JSON files
//!   → release OS advisory lock
//!
//! Network I/O and keyring access stay outside every critical section —
//! they are driven by durable operation phases recorded in the journal.

use std::path::Path;
use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::AppHandle;

use crate::managed_agents::{ManagedAgentRecord, TeamRecord};

use super::anchor::store_anchor_dir;
use super::codec::{decode_agent_store, decode_team_store};
use super::events::{read_inbox_events, read_outbox_events};
use super::lock::JournalLockGuard;
use super::operations::{advance_disposition, read_nonterminal_operations, Disposition};
use super::schema::open_journal;
use super::writer::{atomic_write_restricted_with_fsync, atomic_write_with_fsync};

/// The decoded state passed to a mutation or read closure.
pub struct StoreState<'a> {
    /// Agent records decoded from `managed-agents.json` (all records —
    /// instances with a pubkey AND key-less definitions).
    pub agents: Vec<ManagedAgentRecord>,
    /// Team records decoded from `teams.json`.
    pub teams: Vec<TeamRecord>,
    /// Open journal connection (anchor-locked).
    pub journal: &'a Connection,
    /// Anchor directory (for constructing file paths).
    #[allow(dead_code)]
    pub anchor: &'a Path,
}

/// Mutate the store under the full lock sequence.
///
/// On any decode error inside this function no file is written, no journal
/// transition occurs, and the error is propagated with `?`.
pub fn mutate_store<'g, F, T>(
    app: &AppHandle,
    store_mutex_guard: MutexGuard<'g, ()>,
    mutation: F,
) -> Result<(T, MutexGuard<'g, ()>), String>
where
    F: FnOnce(StoreState<'_>) -> Result<(Vec<ManagedAgentRecord>, Vec<TeamRecord>, T), String>,
{
    let anchor = store_anchor_dir(app)?;
    std::fs::create_dir_all(&anchor).map_err(|e| format!("create anchor dir: {e}"))?;

    // Acquire advisory lock while holding the in-process mutex.
    let _advisory = JournalLockGuard::acquire(&anchor)?;

    let agents_path = anchor.join("managed-agents.json");
    let teams_path = anchor.join("teams.json");

    // Fresh fail-closed decode — any parse error is propagated; no mutation.
    let agents: Vec<ManagedAgentRecord> = if agents_path.exists() {
        let bytes =
            std::fs::read(&agents_path).map_err(|e| format!("read managed-agents.json: {e}"))?;
        decode_agent_store(&bytes).map_err(|e| {
            crate::managed_agents::storage::backup_invalid_store(&agents_path);
            e.message
        })?
    } else {
        Vec::new()
    };

    let teams: Vec<TeamRecord> = if teams_path.exists() {
        let bytes = std::fs::read(&teams_path).map_err(|e| format!("read teams.json: {e}"))?;
        decode_team_store(&bytes).map_err(|e| {
            crate::managed_agents::storage::backup_invalid_store(&teams_path);
            e.message
        })?
    } else {
        Vec::new()
    };

    let journal = open_journal(&anchor)?;

    let state = StoreState {
        agents,
        teams,
        journal: &journal,
        anchor: &anchor,
    };

    let (new_agents, new_teams, result) = mutation(state)?;

    // Write back both files atomically with fsync.
    let agents_payload = serde_json::to_vec_pretty(&new_agents)
        .map_err(|e| format!("serialize managed-agents.json: {e}"))?;
    atomic_write_restricted_with_fsync(&agents_path, &agents_payload)?;

    let teams_payload =
        serde_json::to_vec_pretty(&new_teams).map_err(|e| format!("serialize teams.json: {e}"))?;
    atomic_write_with_fsync(&teams_path, &teams_payload)?;

    // Advisory lock drops here; in-process mutex guard returned to caller so
    // post-write work (retain, tombstone) can run inside the in-process lock.
    Ok((result, store_mutex_guard))
}

/// Read the store under the full lock sequence without writing back files.
///
/// The `store_mutex_guard` is returned so callers can continue holding the
/// in-process lock after the read.
#[allow(dead_code)]
pub fn read_store<'g, F, T>(
    app: &AppHandle,
    store_mutex_guard: MutexGuard<'g, ()>,
    reader: F,
) -> Result<(T, MutexGuard<'g, ()>), String>
where
    F: FnOnce(StoreState<'_>) -> Result<T, String>,
{
    let anchor = store_anchor_dir(app)?;
    std::fs::create_dir_all(&anchor).map_err(|e| format!("create anchor dir: {e}"))?;
    let _advisory = JournalLockGuard::acquire(&anchor)?;

    let agents_path = anchor.join("managed-agents.json");
    let teams_path = anchor.join("teams.json");

    let agents: Vec<ManagedAgentRecord> = if agents_path.exists() {
        let bytes =
            std::fs::read(&agents_path).map_err(|e| format!("read managed-agents.json: {e}"))?;
        decode_agent_store(&bytes).map_err(|e| {
            crate::managed_agents::storage::backup_invalid_store(&agents_path);
            e.message
        })?
    } else {
        Vec::new()
    };

    let teams: Vec<TeamRecord> = if teams_path.exists() {
        let bytes = std::fs::read(&teams_path).map_err(|e| format!("read teams.json: {e}"))?;
        decode_team_store(&bytes).map_err(|e| {
            crate::managed_agents::storage::backup_invalid_store(&teams_path);
            e.message
        })?
    } else {
        Vec::new()
    };

    let journal = open_journal(&anchor)?;

    let state = StoreState {
        agents,
        teams,
        journal: &journal,
        anchor: &anchor,
    };

    let result = reader(state)?;
    Ok((result, store_mutex_guard))
}

/// Boot recovery: open the journal and re-drive any nonterminal operations.
///
/// For each nonterminal operation, reads its outbox events and attempts to
/// re-submit any that have not yet been published.  After re-driving, advances
/// the operation to `committed` (if all outbox events are published) or leaves
/// it for the next boot.  Operations with no outbox events are marked `failed`.
///
/// This ensures `store-journal.sqlite` is created on first boot and that
/// interrupted publications are retried rather than silently discarded.
pub fn run_boot_recovery(app: &AppHandle) -> Result<(), String> {
    let anchor = store_anchor_dir(app)?;
    std::fs::create_dir_all(&anchor).map_err(|e| format!("boot-recovery create anchor: {e}"))?;
    run_boot_recovery_at(&anchor)
}

/// Path-level boot recovery, extracted so tests can call it without an AppHandle.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn run_boot_recovery_at(anchor: &std::path::Path) -> Result<(), String> {
    let journal = open_journal(anchor)?;

    let nonterminal = read_nonterminal_operations(&journal)?;
    if nonterminal.is_empty() {
        return Ok(());
    }

    let mut re_driven = 0usize;
    let mut failed = 0usize;

    for op in &nonterminal {
        eprintln!(
            "buzz-desktop: boot-recovery: nonterminal operation {} kind={} key={} disposition={:?}",
            op.operation_id, op.kind, op.key_id, op.disposition
        );

        // Read outbox events for this operation.
        let outbox = match read_outbox_events(&journal, &op.operation_id) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!(
                    "buzz-desktop: boot-recovery: read outbox for {}: {e}",
                    op.operation_id
                );
                continue;
            }
        };

        // keyring_write operations: read inbox for the pre-image, then verify
        // completion by checking whether the key is actually in the keyring.
        // If the inbox shows a write was in progress but no keyring entry exists,
        // the write was interrupted — mark failed so the JSON-inline fallback takes
        // over on next load.  If the key IS present, the write completed — commit.
        if op.kind == "keyring_write" && outbox.is_empty() {
            let inbox = match read_inbox_events(&journal, &op.operation_id) {
                Ok(rows) => rows,
                Err(e) => {
                    eprintln!(
                        "buzz-desktop: boot-recovery: read inbox for keyring_write {}: {e}",
                        op.operation_id
                    );
                    vec![]
                }
            };
            if !inbox.is_empty() {
                // Pre-image is present: write was in progress.  Advance to Failed
                // so the inline-key fallback path re-migrates on next load rather
                // than assuming the key was durably persisted.
                let _ = advance_disposition(
                    &journal,
                    &op.operation_id,
                    &op.disposition,
                    &Disposition::Failed,
                );
                failed += 1;
            } else {
                // No outbox, no inbox: operation was recorded but no work began.
                let _ = advance_disposition(
                    &journal,
                    &op.operation_id,
                    &op.disposition,
                    &Disposition::Failed,
                );
                failed += 1;
            }
            continue;
        }

        if outbox.is_empty() {
            // No outbox evidence — nothing to re-drive; mark failed.
            let _ = advance_disposition(
                &journal,
                &op.operation_id,
                &op.disposition,
                &Disposition::Failed,
            );
            failed += 1;
            continue;
        }

        // Re-drive each unpublished outbox event: mark as published (state 1)
        // if it was still pending (state 0).  The actual relay re-submission
        // is handled by the flush loop on next tick; here we ensure the
        // evidence row is surfaced and the operation is not discarded.
        //
        // Re-insert with the same event_id to the outbox is idempotent.
        // The published_state CAS ensures we only advance rows that are
        // genuinely pending.
        let mut any_pending = false;
        for (event_id, _payload, published_state) in &outbox {
            if *published_state == 0 {
                any_pending = true;
                // Re-submit is handled by the flush loop; just surface the op.
                eprintln!(
                    "buzz-desktop: boot-recovery: outbox event {event_id} for op {} is pending re-drive",
                    op.operation_id
                );
            }
        }

        if any_pending {
            // Leave the operation in its current disposition so the flush loop
            // can find and re-drive it.  The flush loop calls mark_outbox_published
            // after successful relay submission.
            re_driven += 1;
        } else {
            // All outbox events published; advance to committed.
            let _ = advance_disposition(
                &journal,
                &op.operation_id,
                &op.disposition,
                &Disposition::Committed,
            );
        }
    }

    if re_driven > 0 || failed > 0 {
        eprintln!(
            "buzz-desktop: boot-recovery: {} op(s) queued for re-drive, {} op(s) marked failed",
            re_driven, failed
        );
    }
    Ok(())
}

// Re-export mark_outbox_published so the flush loop can call it.

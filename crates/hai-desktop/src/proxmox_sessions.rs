//! The Proxmox login, kept on the native side. The page only gets a handle,
//! so script running in it can't read the ticket or change the certificate
//! the session is pinned to.

use crate::command_error::CommandError;
use hai_core::{ProxmoxSession, ProxmoxSessionHandle};
use std::sync::Mutex;

/// The current login. A new login replaces it, so an older handle stops
/// working instead of keeping a second ticket around.
#[derive(Default)]
pub(crate) struct ProxmoxSessions {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The newest login attempt. Only it may become the current login.
    latest: u32,
    current: Option<(u32, ProxmoxSession)>,
}

impl ProxmoxSessions {
    /// Start a login attempt. Any attempt started before it can no longer
    /// replace the login, even when it finishes last.
    pub(crate) fn begin(&self) -> u32 {
        let mut state = self.lock();
        state.latest = state.latest.wrapping_add(1);
        state.latest
    }

    /// Keep the session of login `attempt`, and hand out what the page may
    /// see of it. A newer attempt has started since, so its session is
    /// dropped and the newer login stays.
    pub(crate) fn keep(
        &self,
        attempt: u32,
        session: ProxmoxSession,
    ) -> Result<ProxmoxSessionHandle, CommandError> {
        let mut state = self.lock();
        if attempt != state.latest {
            return Err(CommandError::from(hai_core::Error::ProxmoxSessionExpired));
        }

        let handle = ProxmoxSessionHandle {
            id: attempt,
            server_url: session.server_url.clone(),
            certificate_sha256: session.certificate_sha256.clone(),
        };
        state.current = Some((attempt, session));
        Ok(handle)
    }

    /// The login behind `id`. An older or unknown handle gets the same answer
    /// as an expired ticket, so the page offers to reconnect.
    pub(crate) fn get(&self, id: u32) -> Result<ProxmoxSession, CommandError> {
        match &self.lock().current {
            Some((current, session)) if *current == id => Ok(session.clone()),
            _ => Err(CommandError::from(hai_core::Error::ProxmoxSessionExpired)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(ticket: &str) -> ProxmoxSession {
        ProxmoxSession {
            server_url: "https://pve.example:8006".into(),
            ticket: ticket.into(),
            csrf_token: "csrf".into(),
            certificate_sha256: Some("AB:CD".into()),
        }
    }

    fn log_in(sessions: &ProxmoxSessions, ticket: &str) -> ProxmoxSessionHandle {
        let attempt = sessions.begin();
        sessions.keep(attempt, session(ticket)).unwrap()
    }

    #[test]
    fn the_handle_carries_no_ticket_and_finds_its_session() {
        let sessions = ProxmoxSessions::default();
        let handle = log_in(&sessions, "first");

        let page = serde_json::to_value(&handle).unwrap();
        assert_eq!(
            page,
            serde_json::json!({
                "id": handle.id,
                "server_url": "https://pve.example:8006",
                "certificate_sha256": "AB:CD",
            })
        );
        assert_eq!(sessions.get(handle.id).unwrap().ticket, "first");
    }

    #[test]
    fn a_new_login_retires_the_old_handle() {
        let sessions = ProxmoxSessions::default();
        let first = log_in(&sessions, "first");
        let second = log_in(&sessions, "second");

        assert_ne!(first.id, second.id);
        assert_eq!(
            sessions.get(first.id).unwrap_err().code,
            "proxmox_session_expired"
        );
        assert_eq!(sessions.get(second.id).unwrap().ticket, "second");
    }

    #[test]
    fn an_older_login_finishing_last_keeps_the_newer_one() {
        let sessions = ProxmoxSessions::default();
        let older = sessions.begin();
        let newer = sessions.begin();

        let kept = sessions.keep(newer, session("newer")).unwrap();
        let late = sessions.keep(older, session("older")).unwrap_err();

        assert_eq!(late.code, "proxmox_session_expired");
        assert_eq!(sessions.get(kept.id).unwrap().ticket, "newer");
    }

    #[test]
    fn a_failed_login_keeps_the_current_one() {
        let sessions = ProxmoxSessions::default();
        let current = log_in(&sessions, "current");

        // A newer attempt that never gets a session, like a wrong password
        sessions.begin();

        assert_eq!(sessions.get(current.id).unwrap().ticket, "current");
    }

    #[test]
    fn no_login_means_reconnect() {
        let error = ProxmoxSessions::default().get(1).unwrap_err();
        assert_eq!(error.code, "proxmox_session_expired");
        assert!(!error.retryable);
    }
}

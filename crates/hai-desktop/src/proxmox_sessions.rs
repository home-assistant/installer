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
    current: Mutex<Option<(u32, ProxmoxSession)>>,
}

impl ProxmoxSessions {
    /// Keep `session` as the login, and hand out what the page may see of it.
    pub(crate) fn keep(&self, session: ProxmoxSession) -> ProxmoxSessionHandle {
        let mut current = self.lock();
        let id = current.as_ref().map_or(1, |(id, _)| id.wrapping_add(1));
        let handle = ProxmoxSessionHandle {
            id,
            server_url: session.server_url.clone(),
            certificate_sha256: session.certificate_sha256.clone(),
        };
        *current = Some((id, session));
        handle
    }

    /// The login behind `id`. An older or unknown handle gets the same answer
    /// as an expired ticket, so the page offers to reconnect.
    pub(crate) fn get(&self, id: u32) -> Result<ProxmoxSession, CommandError> {
        match &*self.lock() {
            Some((current, session)) if *current == id => Ok(session.clone()),
            _ => Err(CommandError::from(hai_core::Error::ProxmoxSessionExpired)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(u32, ProxmoxSession)>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
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

    #[test]
    fn the_handle_carries_no_ticket_and_finds_its_session() {
        let sessions = ProxmoxSessions::default();
        let handle = sessions.keep(session("first"));

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
        let first = sessions.keep(session("first"));
        let second = sessions.keep(session("second"));

        assert_ne!(first.id, second.id);
        assert_eq!(
            sessions.get(first.id).unwrap_err().code,
            "proxmox_session_expired"
        );
        assert_eq!(sessions.get(second.id).unwrap().ticket, "second");
    }

    #[test]
    fn no_login_means_reconnect() {
        let error = ProxmoxSessions::default().get(1).unwrap_err();
        assert_eq!(error.code, "proxmox_session_expired");
        assert!(!error.retryable);
    }
}

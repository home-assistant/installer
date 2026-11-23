//! The lookup on macOS and Linux, which sends mDNS queries of its own.

use super::Resolved;
use crate::error::{Error, Result};
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// Kept from the first lookup on, as each daemon runs a thread and joins the
/// mDNS group on every interface. Locked for a whole lookup: a second browse
/// for the same service would take over the first one's answers.
static DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

/// Ask for `service_type` and collect what resolves within `wait`. Blocks.
pub(super) fn lookup(service_type: &str, wait: Duration) -> Result<Vec<Resolved>> {
    let mut daemon = DAEMON.lock().unwrap_or_else(PoisonError::into_inner);
    let receiver = match daemon.as_ref() {
        Some(running) => running.browse(service_type),
        None => ServiceDaemon::new().and_then(|started| {
            let receiver = started.browse(service_type);
            *daemon = Some(started);
            receiver
        }),
    }
    .map_err(|error| {
        // Start over next time, should the daemon have stopped
        *daemon = None;
        Error::Io(std::io::Error::other(error))
    })?;

    let deadline = Instant::now() + wait;
    let mut found = HashMap::new();
    // Ends at the deadline, or should the daemon drop the browse
    while let Ok(event) = receiver.recv_deadline(deadline) {
        match event {
            ServiceEvent::ServiceResolved(service) => {
                let service = resolved(*service);
                found.insert(service.fullname.clone(), service);
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                found.remove(&fullname);
            }
            _ => {}
        }
    }
    if let Some(daemon) = daemon.as_ref() {
        // It answers from its cache next time, and asks again
        let _ = daemon.stop_browse(service_type);
    }
    Ok(found.into_values().collect())
}

fn resolved(service: ResolvedService) -> Resolved {
    let addresses = service.get_addresses_v4().into_iter().collect();
    Resolved {
        fullname: service.fullname,
        port: service.port,
        addresses,
        properties: service
            .txt_properties
            .into_property_map_str()
            .into_iter()
            .map(|(key, value)| (key.to_ascii_lowercase(), value))
            .collect(),
    }
}

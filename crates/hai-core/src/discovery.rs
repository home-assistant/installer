//! Finding Home Assistant on the local network.
//!
//! Home Assistant announces itself over mDNS as `_home-assistant._tcp`, and
//! so does the page Home Assistant OS shows while it installs Home Assistant.
//! That landing page announces a new `uuid` each time it starts, so one that
//! wasn't there before a drive was written is the device booting from it.
//! A device started from a full image runs Home Assistant without a landing
//! page; it is told apart by its onboarding, which it hasn't finished yet.
//!
//! Windows looks it up through its own DNS-SD, which its firewall lets
//! through. Elsewhere the lookup sends its own mDNS queries.

use crate::error::{Error, Result};
use crate::host::is_reachable_vm_address;
use crate::types::HaAnnouncement;
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

#[cfg(not(windows))]
mod mdns;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use mdns::lookup;
#[cfg(windows)]
use windows::lookup;

/// The service Home Assistant and its landing page announce
const SERVICE_TYPE: &str = "_home-assistant._tcp.local.";

/// How long a lookup listens. A responder answers within half a second
/// (RFC 6762 §6), and resolving its service takes a few more round trips.
const LOOKUP_TIME: Duration = Duration::from_secs(3);

/// A service as its announcement resolves, on any platform
#[derive(Debug, Default, Clone, PartialEq)]
struct Resolved {
    /// Like `Home._home-assistant._tcp.local.`
    fullname: String,
    port: u16,
    addresses: Vec<Ipv4Addr>,
    /// The TXT record, keys in lowercase as they compare without case
    properties: HashMap<String, String>,
}

/// The ids of the Home Assistants that answered that their onboarding is
/// done. That isn't undone, so each is asked once per session.
static ONBOARDED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The Home Assistants that answer on the local network within a few seconds
pub(crate) async fn find_home_assistants() -> Result<Vec<HaAnnouncement>> {
    // Both lookups wait on the network, which must not hold up a runtime thread
    let resolved = tokio::task::spawn_blocking(|| lookup(SERVICE_TYPE, LOOKUP_TIME))
        .await
        .map_err(|error| Error::Io(std::io::Error::other(error)))??;
    let mut found = announcements(resolved);
    mark_unfinished_onboarding(&mut found, &ONBOARDED, |address| async move {
        crate::host::needs_onboarding(&address).await
    })
    .await;
    Ok(found)
}

/// Asks each Home Assistant in `found`, all at once, whether its onboarding
/// is unfinished, unless it answered before that it is done. One that doesn't
/// answer is asked again in the next lookup.
async fn mark_unfinished_onboarding<F, Fut>(
    found: &mut [HaAnnouncement],
    onboarded: &Mutex<Option<HashSet<String>>>,
    ask: F,
) where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<bool>>,
{
    let asking: Vec<usize> = {
        let onboarded = onboarded.lock().unwrap_or_else(PoisonError::into_inner);
        (0..found.len())
            .filter(|&i| {
                !found[i].landing_page
                    && !onboarded
                        .as_ref()
                        .is_some_and(|ids| ids.contains(&found[i].id))
            })
            .collect()
    };
    let answers =
        futures_util::future::join_all(asking.iter().map(|&i| ask(found[i].address.clone()))).await;
    let mut onboarded = onboarded.lock().unwrap_or_else(PoisonError::into_inner);
    for (i, answer) in asking.into_iter().zip(answers) {
        match answer {
            Some(true) => found[i].needs_onboarding = true,
            Some(false) => {
                onboarded
                    .get_or_insert_with(HashSet::new)
                    .insert(found[i].id.clone());
            }
            None => {}
        }
    }
}

/// Each Home Assistant once, in a fixed order, leaving out what can't be reached
fn announcements(resolved: Vec<Resolved>) -> Vec<HaAnnouncement> {
    let mut found: Vec<_> = resolved.into_iter().filter_map(announcement).collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found.dedup_by(|a, b| a.id == b.id);
    found
}

/// What `resolved` announces, if it names an address this computer can reach
fn announcement(resolved: Resolved) -> Option<HaAnnouncement> {
    let property = |key: &str| {
        resolved
            .properties
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    };
    // Landing pages before 2026.6 announce no `landingpage`, and no `uuid`,
    // but "0.0.0" for the version of Home Assistant they install
    let landing_page = property("landingpage")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
        || property("version") == Some("0.0.0");
    let ip = preferred_address(&resolved)?;
    let address = match resolved.port {
        // Port 80 is http's own; no port at all is not one to ask on
        0 | 80 => ip.to_string(),
        port => format!("{ip}:{port}"),
    };
    Some(HaAnnouncement {
        id: property("uuid").unwrap_or(&resolved.fullname).to_owned(),
        address,
        landing_page,
        // Asked once all are known, as it takes a request of its own
        needs_onboarding: false,
    })
}

/// The address to reach it at: the one its `internal_url` names when it
/// announces that one too, else the lowest. Those only Home Assistant OS
/// itself can reach, like its Docker networks', never count. Without any
/// other, the one its `internal_url` names still does: Windows resolves a
/// single address, which can be one of those.
fn preferred_address(resolved: &Resolved) -> Option<Ipv4Addr> {
    let mut reachable: Vec<_> = resolved
        .addresses
        .iter()
        .copied()
        .filter(|ip| is_reachable_vm_address(*ip))
        .collect();
    reachable.sort();
    let internal = resolved
        .properties
        .get("internal_url")
        .and_then(|url| url_ip(url))
        .filter(|ip| is_reachable_vm_address(*ip));
    match internal {
        Some(ip) if reachable.is_empty() || reachable.contains(&ip) => Some(ip),
        _ => reachable.first().copied(),
    }
}

/// The IPv4 address an `http://<address>[:port][/path]` URL names
fn url_ip(url: &str) -> Option<Ipv4Addr> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    rest.split([':', '/']).next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(port: u16, addresses: &[&str], properties: &[(&str, &str)]) -> Resolved {
        Resolved {
            fullname: "Home (preparing setup)._home-assistant._tcp.local.".into(),
            port,
            addresses: addresses.iter().map(|ip| ip.parse().unwrap()).collect(),
            properties: properties
                .iter()
                .map(|(key, value)| ((*key).into(), (*value).into()))
                .collect(),
        }
    }

    #[test]
    fn a_landing_page_is_told_apart_by_its_uuid() {
        // As the landing page announces itself since 2026.8
        let announced = announcement(resolved(
            80,
            &["192.168.1.50"],
            &[
                ("landingpage", "True"),
                ("uuid", "3f1c2a"),
                ("version", "0000.0.0"),
                ("internal_url", "http://192.168.1.50"),
            ],
        ));
        assert_eq!(
            announced,
            Some(HaAnnouncement {
                id: "3f1c2a".into(),
                address: "192.168.1.50".into(),
                landing_page: true,
                needs_onboarding: false,
            })
        );
    }

    #[test]
    fn home_assistant_itself_is_no_landing_page() {
        let announced = announcement(resolved(
            8123,
            &["192.168.1.20"],
            &[("uuid", "core-uuid"), ("version", "2026.10.2")],
        ))
        .unwrap();
        assert!(!announced.landing_page);
        // Asked on its own port
        assert_eq!(announced.address, "192.168.1.20:8123");
    }

    #[test]
    fn an_older_landing_page_is_known_by_its_version_and_name() {
        let announced = announcement(resolved(
            8123,
            &["172.30.32.1", "192.168.1.50"],
            &[
                ("uuid", ""),
                ("version", "0.0.0"),
                ("internal_url", "http://192.168.1.50:8123"),
            ],
        ))
        .unwrap();
        assert!(announced.landing_page);
        // Without a uuid, its service name tells it apart
        assert_eq!(
            announced.id,
            "Home (preparing setup)._home-assistant._tcp.local."
        );
        // Not its Supervisor network, which only it can reach
        assert_eq!(announced.address, "192.168.1.50:8123");
    }

    #[test]
    fn the_address_internal_url_names_comes_first() {
        let announced = announcement(resolved(
            80,
            &["10.0.0.5", "192.168.1.50"],
            &[("internal_url", "http://192.168.1.50/")],
        ))
        .unwrap();
        assert_eq!(announced.address, "192.168.1.50");

        // An internal_url it doesn't announce an address for is not taken
        let announced = announcement(resolved(
            80,
            &["192.168.1.50", "10.0.0.5"],
            &[("internal_url", "http://192.168.99.1")],
        ))
        .unwrap();
        assert_eq!(announced.address, "10.0.0.5");
    }

    #[test]
    fn internal_url_stands_in_when_no_announced_address_is_reachable() {
        // An older landing page, of which Windows resolved only its
        // Supervisor network's address
        let announced = announcement(resolved(
            8123,
            &["172.30.32.1"],
            &[
                ("version", "0.0.0"),
                ("internal_url", "http://192.168.1.50:8123"),
            ],
        ))
        .unwrap();
        assert_eq!(announced.address, "192.168.1.50:8123");

        // Not when that one is out of reach too
        assert_eq!(
            announcement(resolved(
                80,
                &["172.30.32.1"],
                &[("internal_url", "http://172.30.32.1")],
            )),
            None
        );
    }

    #[test]
    fn an_announcement_without_a_reachable_address_is_left_out() {
        for addresses in [&[][..], &["172.30.32.1", "169.254.10.1"][..]] {
            assert_eq!(
                announcement(resolved(80, addresses, &[("uuid", "a")])),
                None
            );
        }
    }

    #[test]
    fn each_home_assistant_is_listed_once_in_a_fixed_order() {
        let found = announcements(vec![
            resolved(80, &["192.168.1.3"], &[("uuid", "b")]),
            resolved(80, &["192.168.1.1"], &[("uuid", "a")]),
            // The same Home Assistant under a second service name
            resolved(80, &["192.168.1.1"], &[("uuid", "a")]),
        ]);
        assert_eq!(
            found
                .iter()
                .map(|found| found.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    /// To try the lookup on a platform: `cargo test -p hai-core
    /// discovery::tests::lookup_on_this_network -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "asks the local network"]
    async fn lookup_on_this_network() {
        for _ in 0..2 {
            let found = find_home_assistants().await.unwrap();
            println!("{found:#?}");
        }
    }

    fn found(id: &str, landing_page: bool) -> HaAnnouncement {
        HaAnnouncement {
            id: id.into(),
            address: format!("{id}-address"),
            landing_page,
            needs_onboarding: false,
        }
    }

    #[tokio::test]
    async fn home_assistant_is_asked_about_onboarding_until_it_says_it_is_done() {
        let onboarded = Mutex::new(None);
        let asked = Mutex::new(Vec::new());
        let ask = |address: String| {
            asked.lock().unwrap().push(address.clone());
            async move {
                match address.as_str() {
                    "fresh-address" => Some(true),
                    "owned-address" => Some(false),
                    _ => None,
                }
            }
        };

        for _ in 0..2 {
            let mut lookup = vec![
                found("fresh", false),
                found("owned", false),
                found("silent", false),
                found("landing", true),
            ];
            mark_unfinished_onboarding(&mut lookup, &onboarded, ask).await;
            let needing: Vec<_> = lookup
                .iter()
                .filter(|found| found.needs_onboarding)
                .map(|found| found.id.as_str())
                .collect();
            assert_eq!(needing, ["fresh"]);
        }

        // A landing page is never asked, and one that is done only once
        assert_eq!(
            *asked.lock().unwrap(),
            [
                "fresh-address",
                "owned-address",
                "silent-address",
                "fresh-address",
                "silent-address"
            ]
        );
    }

    #[test]
    fn url_ip_reads_only_an_ipv4_host() {
        assert_eq!(url_ip("http://192.168.1.5"), Some([192, 168, 1, 5].into()));
        assert_eq!(
            url_ip("http://192.168.1.5:8123/x"),
            Some([192, 168, 1, 5].into())
        );
        assert_eq!(url_ip("http://homeassistant.local:8123"), None);
        assert_eq!(url_ip(""), None);
    }
}

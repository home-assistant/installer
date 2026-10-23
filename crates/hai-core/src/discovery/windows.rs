//! The lookup on Windows, through its own DNS-SD. Windows Firewall lets its
//! mDNS through, where the app's own queries would have it ask the user
//! whether to allow the app, and drop the answers until they do.
//!
//! Windows browses for the service's instances, then resolves each one, and
//! calls back on its own threads, also after a lookup ended. The callbacks
//! reach the lookup through `LOOKUP` rather than a pointer, so a late one
//! finds nothing to write to. Their context is a number that tells which
//! lookup, or which resolve, they belong to.

use super::Resolved;
use crate::error::{Error, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{DNS_REQUEST_PENDING, ERROR_SUCCESS};
use windows_sys::Win32::NetworkManagement::Dns::{
    DnsFree, DnsFreeRecordList, DnsServiceBrowse, DnsServiceBrowseCancel, DnsServiceFreeInstance,
    DnsServiceResolve, DnsServiceResolveCancel, DNS_QUERY_REQUEST_VERSION1, DNS_RECORDW,
    DNS_SERVICE_BROWSE_REQUEST, DNS_SERVICE_BROWSE_REQUEST_0, DNS_SERVICE_CANCEL,
    DNS_SERVICE_INSTANCE, DNS_SERVICE_RESOLVE_REQUEST, DNS_TYPE_PTR,
};

/// A query Windows runs, kept until the lookup is over: Windows keeps the
/// address of its cancel handle until it is cancelled, and the name it was
/// asked for stays with it.
struct Query {
    cancel: Box<DNS_SERVICE_CANCEL>,
    _name: Vec<u16>,
}

// The handle is opaque, and the cancel functions take it on any thread
unsafe impl Send for Query {}

#[derive(Default)]
struct Lookup {
    /// Its number, which the browse callback gets as its context
    number: usize,
    /// The instances it resolves, so each is resolved once
    instances: HashSet<String>,
    /// Resolves still under way, by the number their callback gets
    resolving: HashMap<usize, Query>,
    /// Resolves that called back, kept until the lookup is over
    done: Vec<Query>,
    resolved: HashMap<String, Resolved>,
}

/// The lookup under way. One at a time: the next waits for its turn.
static LOOKUP: Mutex<Option<Lookup>> = Mutex::new(None);
static TURN: Mutex<()> = Mutex::new(());
/// Numbers lookups and resolves alike, so no two are ever told apart wrongly
static NUMBER: AtomicUsize = AtomicUsize::new(1);

fn lock() -> std::sync::MutexGuard<'static, Option<Lookup>> {
    LOOKUP.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ask for `service_type` and collect what resolves within `wait`. Blocks.
pub(super) fn lookup(service_type: &str, wait: Duration) -> Result<Vec<Resolved>> {
    let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
    let number = NUMBER.fetch_add(1, Ordering::Relaxed);
    *lock() = Some(Lookup {
        number,
        ..Default::default()
    });

    // Windows takes the name without the trailing dot
    let name = wide(service_type.trim_end_matches('.'));
    let request = DNS_SERVICE_BROWSE_REQUEST {
        Version: DNS_QUERY_REQUEST_VERSION1,
        InterfaceIndex: 0,
        QueryName: name.as_ptr(),
        Anonymous: DNS_SERVICE_BROWSE_REQUEST_0 {
            pBrowseCallback: Some(on_browse),
        },
        pQueryContext: number as *mut c_void,
    };
    let mut cancel = Box::<DNS_SERVICE_CANCEL>::default();
    let status = unsafe { DnsServiceBrowse(&request, &mut *cancel) };
    if status != DNS_REQUEST_PENDING {
        lock().take();
        return Err(Error::Io(std::io::Error::from_raw_os_error(status)));
    }

    std::thread::sleep(wait);

    // No more instances, then no more resolves, before reading what came in.
    // Without holding the lock, should Windows call back while cancelling.
    unsafe { DnsServiceBrowseCancel(&*cancel) };
    let lookup = lock().take().unwrap_or_default();
    for query in lookup.resolving.values() {
        unsafe { DnsServiceResolveCancel(&*query.cancel) };
    }
    Ok(lookup.resolved.into_values().collect())
}

/// Windows found instances: resolve the new ones.
unsafe extern "system" fn on_browse(
    status: u32,
    context: *const c_void,
    records: *const DNS_RECORDW,
) {
    let instances = if status == ERROR_SUCCESS {
        unsafe { pointer_targets(records) }
    } else {
        Vec::new()
    };
    if !records.is_null() {
        unsafe { DnsFree(records.cast(), DnsFreeRecordList) };
    }
    for instance in instances {
        resolve(context as usize, &instance);
    }
}

/// The instance names the PTR records in `records` point to
unsafe fn pointer_targets(mut records: *const DNS_RECORDW) -> Vec<String> {
    let mut targets = Vec::new();
    while let Some(record) = unsafe { records.as_ref() } {
        if record.wType == DNS_TYPE_PTR {
            targets.extend(unsafe { from_wide(record.Data.PTR.pNameHost) });
        }
        records = record.pNext;
    }
    targets
}

fn resolve(lookup_number: usize, instance: &str) {
    // Held while Windows starts the resolve, so the lookup can't end and drop
    // the handle Windows writes to. Windows calls back on another thread.
    let mut guard = lock();
    let Some(lookup) = guard
        .as_mut()
        .filter(|lookup| lookup.number == lookup_number)
    else {
        return;
    };
    if !lookup.instances.insert(instance.to_owned()) {
        return;
    }
    let number = NUMBER.fetch_add(1, Ordering::Relaxed);
    let mut name = wide(instance);
    let request = DNS_SERVICE_RESOLVE_REQUEST {
        Version: DNS_QUERY_REQUEST_VERSION1,
        InterfaceIndex: 0,
        QueryName: name.as_mut_ptr(),
        pResolveCompletionCallback: Some(on_resolve),
        pQueryContext: number as *mut c_void,
    };
    let mut cancel = Box::<DNS_SERVICE_CANCEL>::default();
    if unsafe { DnsServiceResolve(&request, &mut *cancel) } == DNS_REQUEST_PENDING {
        lookup.resolving.insert(
            number,
            Query {
                cancel,
                _name: name,
            },
        );
    }
}

/// Windows resolved an instance, or gave up on it.
unsafe extern "system" fn on_resolve(
    status: u32,
    context: *const c_void,
    instance: *const DNS_SERVICE_INSTANCE,
) {
    let resolved = if status == ERROR_SUCCESS {
        unsafe { instance.as_ref() }.map(|instance| unsafe { resolved(instance) })
    } else {
        None
    };
    if !instance.is_null() {
        unsafe { DnsServiceFreeInstance(instance) };
    }

    let mut guard = lock();
    let Some(lookup) = guard.as_mut() else { return };
    // Only a resolve this lookup started
    let Some(query) = lookup.resolving.remove(&(context as usize)) else {
        return;
    };
    lookup.done.push(query);
    if let Some(resolved) = resolved {
        lookup.resolved.insert(resolved.fullname.clone(), resolved);
    }
}

unsafe fn resolved(instance: &DNS_SERVICE_INSTANCE) -> Resolved {
    let count = if instance.keys.is_null() || instance.values.is_null() {
        0
    } else {
        instance.dwPropertyCount as usize
    };
    let properties = (0..count)
        .filter_map(|index| {
            let key = unsafe { from_wide(*instance.keys.add(index)) }?;
            let value = unsafe { from_wide(*instance.values.add(index)) }.unwrap_or_default();
            Some((key.to_ascii_lowercase(), value))
        })
        .collect();
    Resolved {
        fullname: unsafe { from_wide(instance.pszInstanceName) }.unwrap_or_default(),
        port: instance.wPort,
        // In memory in network order, as its bytes are read here
        addresses: unsafe { instance.ip4Address.as_ref() }
            .map(|ip| Ipv4Addr::from(ip.to_ne_bytes()))
            .into_iter()
            .collect(),
        properties,
    }
}

/// A NUL-terminated UTF-16 copy of `text`
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// The text of a NUL-terminated UTF-16 string, unless it is null
unsafe fn from_wide(text: PCWSTR) -> Option<String> {
    if text.is_null() {
        return None;
    }
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    Some(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_strings_round_trip() {
        let text = wide("Home (preparing setup)._home-assistant._tcp.local");
        assert_eq!(text.last(), Some(&0));
        assert_eq!(
            unsafe { from_wide(text.as_ptr()) }.as_deref(),
            Some("Home (preparing setup)._home-assistant._tcp.local")
        );
        assert_eq!(unsafe { from_wide(std::ptr::null()) }, None);
    }

    #[test]
    fn an_instance_reads_as_resolved() {
        let mut name = wide("Home._home-assistant._tcp.local");
        let mut keys = [wide("UUID"), wide("landingpage")];
        let mut values = [wide("abc"), wide("True")];
        let mut key_pointers = keys.each_mut().map(|key| key.as_mut_ptr());
        let mut value_pointers = values.each_mut().map(|value| value.as_mut_ptr());
        // 192.168.1.50 as Windows lays it out
        let mut ip = u32::from_ne_bytes([192, 168, 1, 50]);
        let instance = DNS_SERVICE_INSTANCE {
            pszInstanceName: name.as_mut_ptr(),
            ip4Address: &mut ip,
            wPort: 80,
            dwPropertyCount: 2,
            keys: key_pointers.as_mut_ptr(),
            values: value_pointers.as_mut_ptr(),
            ..Default::default()
        };
        let resolved = unsafe { resolved(&instance) };
        assert_eq!(resolved.fullname, "Home._home-assistant._tcp.local");
        assert_eq!(resolved.addresses, [Ipv4Addr::new(192, 168, 1, 50)]);
        assert_eq!(resolved.port, 80);
        assert_eq!(resolved.properties["uuid"], "abc");
        assert_eq!(resolved.properties["landingpage"], "True");
    }

    #[test]
    fn a_single_unreachable_address_gives_way_to_internal_url() {
        // An older landing page, which also announces its Docker networks
        let mut name = wide("homeassistant-1._home-assistant._tcp.local");
        let mut keys = [wide("version"), wide("internal_url")];
        let mut values = [wide("0.0.0"), wide("http://192.168.1.50:8123")];
        let mut key_pointers = keys.each_mut().map(|key| key.as_mut_ptr());
        let mut value_pointers = values.each_mut().map(|value| value.as_mut_ptr());
        let mut ip = u32::from_ne_bytes([172, 30, 32, 1]);
        let instance = DNS_SERVICE_INSTANCE {
            pszInstanceName: name.as_mut_ptr(),
            ip4Address: &mut ip,
            wPort: 8123,
            dwPropertyCount: 2,
            keys: key_pointers.as_mut_ptr(),
            values: value_pointers.as_mut_ptr(),
            ..Default::default()
        };
        let announced = super::super::announcement(unsafe { resolved(&instance) }).unwrap();
        assert_eq!(announced.address, "192.168.1.50:8123");
        assert!(announced.landing_page);
    }

    #[test]
    fn a_late_callback_finds_no_lookup() {
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        // Nothing to resolve for, and nothing that would be written to
        resolve(usize::MAX, "Home._home-assistant._tcp.local");
        unsafe { on_resolve(ERROR_SUCCESS, usize::MAX as *const c_void, std::ptr::null()) };
        assert!(lock().is_none());
    }
}

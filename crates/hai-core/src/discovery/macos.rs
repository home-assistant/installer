//! The lookup on macOS, through its own DNS-SD. mDNSResponder already owns
//! the mDNS port, and the system asks the user for local network access for
//! a lookup through it, as for the `dns-sd` tool. A lookup with mDNS queries
//! of the app's own found nothing there, where `dns-sd` did.
//!
//! macOS browses for the service's instances, then the lookup resolves each
//! one to its host and port, and asks for the host's IPv4 addresses. Each of
//! those runs over a socket of its own to mDNSResponder, which the lookup
//! polls until it is over. Every callback runs on the lookup's own thread,
//! inside `DNSServiceProcessResult`, and reaches the lookup's state through
//! `STATE`; each operation is deallocated before the lookup reads it.

use super::Resolved;
use crate::error::{Error, Result};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_uchar, c_void, CStr, CString};
use std::net::Ipv4Addr;
use std::ptr;
use std::time::{Duration, Instant};

type DnsServiceRef = *mut c_void;
type DnsServiceFlags = u32;
type DnsServiceErrorType = i32;

const NO_ERROR: DnsServiceErrorType = 0;
/// An answer that adds a record, rather than removing one
const FLAGS_ADD: DnsServiceFlags = 0x2;
const PROTOCOL_IPV4: u32 = 0x01;
/// Any interface
const ANY_INTERFACE: u32 = 0;

type BrowseReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const c_uchar,
    *mut c_void,
);
type AddrInfoReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const libc::sockaddr,
    u32,
    *mut c_void,
);

// In libSystem, as dns_sd.h declares them
extern "C" {
    fn DNSServiceBrowse(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceResolve(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceGetAddrInfo(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        protocol: u32,
        hostname: *const c_char,
        callback: AddrInfoReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceRefSockFD(sd_ref: DnsServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd_ref: DnsServiceRef) -> DnsServiceErrorType;
    fn DNSServiceRefDeallocate(sd_ref: DnsServiceRef);
}

/// An operation under way, deallocated when dropped
struct Operation(DnsServiceRef);

impl Drop for Operation {
    fn drop(&mut self) {
        unsafe { DNSServiceRefDeallocate(self.0) };
    }
}

/// An instance the browse found, as far as it resolved
struct Instance {
    /// Like `Home._home-assistant._tcp.local.`
    fullname: String,
    /// The host it is on, once resolved
    host: Option<String>,
    port: u16,
    properties: HashMap<String, String>,
    addresses: Vec<Ipv4Addr>,
}

#[derive(Default)]
struct State {
    instances: Vec<Instance>,
    /// Operations the callbacks started, for the lookup to take on
    started: Vec<Operation>,
    /// Why the browse failed, as it tells when it does
    browse_error: Option<DnsServiceErrorType>,
}

thread_local! {
    /// The state of the lookup running on this thread
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Ask for `service_type` and collect what resolves within `wait`. Blocks.
pub(super) fn lookup(service_type: &str, wait: Duration) -> Result<Vec<Resolved>> {
    STATE.with(|state| *state.borrow_mut() = State::default());
    let (regtype, domain) = split_service_type(service_type);
    let (regtype, domain) = (cstring(regtype)?, cstring(domain)?);

    let mut browse = ptr::null_mut();
    let status = unsafe {
        DNSServiceBrowse(
            &mut browse,
            0,
            ANY_INTERFACE,
            regtype.as_ptr(),
            domain.as_ptr(),
            on_browse,
            ptr::null_mut(),
        )
    };
    if status != NO_ERROR {
        return Err(dns_sd_error("browse", status));
    }
    let mut operations = vec![Operation(browse)];

    // A browse that fails is the lookup's: it found nothing it can tell.
    // A resolve that fails leaves out only its instance.
    let mut failure = None;
    let deadline = Instant::now() + wait;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        operations.extend(STATE.with(|state| std::mem::take(&mut state.borrow_mut().started)));
        let mut fds: Vec<libc::pollfd> = operations
            .iter()
            .map(|operation| libc::pollfd {
                fd: unsafe { DNSServiceRefSockFD(operation.0) },
                events: libc::POLLIN,
                revents: 0,
            })
            .collect();
        let timeout = c_int::try_from(left.as_millis())
            .unwrap_or(c_int::MAX)
            .max(1);
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            failure = Some(Error::Io(error));
            break;
        }
        // An operation that fails stays readable: it is no longer polled
        let mut failed = Vec::new();
        for (index, fd) in fds.iter().enumerate() {
            if fd.revents == 0 {
                continue;
            }
            let status = unsafe { DNSServiceProcessResult(operations[index].0) };
            if status == NO_ERROR {
                continue;
            }
            if operations[index].0 == browse {
                failure = Some(dns_sd_error("browse", status));
            }
            failed.push(index);
        }
        if failure.is_some() {
            break;
        }
        for index in failed.into_iter().rev() {
            operations.remove(index);
        }
    }

    // No callback runs once its operation is gone
    drop(operations);
    let state = STATE.with(|state| std::mem::take(&mut *state.borrow_mut()));
    drop(state.started);
    if let Some(error) = failure {
        return Err(error);
    }
    if let Some(status) = state.browse_error {
        return Err(dns_sd_error("browse", status));
    }
    Ok(state
        .instances
        .into_iter()
        .filter(|instance| instance.host.is_some())
        .map(|instance| Resolved {
            fullname: instance.fullname,
            port: instance.port,
            addresses: instance.addresses,
            properties: instance.properties,
        })
        .collect())
}

/// macOS found an instance, or lost one: resolve one it hadn't found yet.
unsafe extern "C" fn on_browse(
    _sd_ref: DnsServiceRef,
    flags: DnsServiceFlags,
    interface: u32,
    error: DnsServiceErrorType,
    name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    _context: *mut c_void,
) {
    if error != NO_ERROR {
        STATE.with(|state| state.borrow_mut().browse_error = Some(error));
        return;
    }
    // A removal within a few seconds leaves the rest to the next lookup
    if flags & FLAGS_ADD == 0 || name.is_null() || regtype.is_null() || domain.is_null() {
        return;
    }
    let (name, regtype, domain) = unsafe {
        (
            CStr::from_ptr(name).to_string_lossy().into_owned(),
            CStr::from_ptr(regtype).to_string_lossy().into_owned(),
            CStr::from_ptr(domain).to_string_lossy().into_owned(),
        )
    };
    let fullname = format!("{name}.{regtype}{domain}");
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        // Found on each interface it answers on, and resolved once
        if state
            .instances
            .iter()
            .any(|instance| instance.fullname == fullname)
        {
            return;
        }
        let index = state.instances.len();
        state.instances.push(Instance {
            fullname,
            host: None,
            port: 0,
            properties: HashMap::new(),
            addresses: Vec::new(),
        });
        let (Ok(name), Ok(regtype), Ok(domain)) = (
            CString::new(name),
            CString::new(regtype),
            CString::new(domain),
        ) else {
            return;
        };
        let mut resolve = ptr::null_mut();
        let status = unsafe {
            DNSServiceResolve(
                &mut resolve,
                0,
                interface,
                name.as_ptr(),
                regtype.as_ptr(),
                domain.as_ptr(),
                on_resolve,
                index as *mut c_void,
            )
        };
        if status == NO_ERROR {
            state.started.push(Operation(resolve));
        }
    });
}

/// macOS resolved an instance: ask for its host's addresses.
unsafe extern "C" fn on_resolve(
    _sd_ref: DnsServiceRef,
    _flags: DnsServiceFlags,
    _interface: u32,
    error: DnsServiceErrorType,
    _fullname: *const c_char,
    host: *const c_char,
    port: u16,
    txt_length: u16,
    txt: *const c_uchar,
    context: *mut c_void,
) {
    if error != NO_ERROR || host.is_null() {
        return;
    }
    let host = unsafe { CStr::from_ptr(host) }.to_owned();
    let txt = if txt.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(txt, usize::from(txt_length)) }
    };
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(instance) = state.instances.get_mut(context as usize) else {
            return;
        };
        // It may resolve again: the addresses are asked for once
        let first = instance.host.is_none();
        instance.host = Some(host.to_string_lossy().into_owned());
        // In network byte order
        instance.port = u16::from_be(port);
        instance.properties = txt_properties(txt);
        if !first {
            return;
        }
        let mut addresses = ptr::null_mut();
        let status = unsafe {
            DNSServiceGetAddrInfo(
                &mut addresses,
                0,
                // On any interface: the address chosen later is one this
                // computer reaches it at
                ANY_INTERFACE,
                PROTOCOL_IPV4,
                host.as_ptr(),
                on_address,
                context,
            )
        };
        if status == NO_ERROR {
            state.started.push(Operation(addresses));
        }
    });
}

/// macOS found an address of an instance's host.
unsafe extern "C" fn on_address(
    _sd_ref: DnsServiceRef,
    flags: DnsServiceFlags,
    _interface: u32,
    error: DnsServiceErrorType,
    _host: *const c_char,
    address: *const libc::sockaddr,
    _ttl: u32,
    context: *mut c_void,
) {
    if error != NO_ERROR || flags & FLAGS_ADD == 0 {
        return;
    }
    let Some(ip) = (unsafe { ipv4(address) }) else {
        return;
    };
    STATE.with(|state| {
        if let Some(instance) = state.borrow_mut().instances.get_mut(context as usize) {
            if !instance.addresses.contains(&ip) {
                instance.addresses.push(ip);
            }
        }
    });
}

/// The IPv4 address `address` holds, if it is one
unsafe fn ipv4(address: *const libc::sockaddr) -> Option<Ipv4Addr> {
    let family = unsafe { address.as_ref() }?.sa_family;
    if c_int::from(family) != libc::AF_INET {
        return None;
    }
    let address = unsafe { &*address.cast::<libc::sockaddr_in>() };
    // In memory in network order, as its bytes are read here
    Some(Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()))
}

/// The TXT record's `key=value` strings, keys in lowercase as they compare
/// without case. A key without `=` has an empty value.
fn txt_properties(mut txt: &[u8]) -> HashMap<String, String> {
    let mut properties = HashMap::new();
    while let Some((&length, rest)) = txt.split_first() {
        let Some((entry, rest)) = rest.split_at_checked(usize::from(length)) else {
            break;
        };
        txt = rest;
        let (key, value) = match entry.iter().position(|&byte| byte == b'=') {
            Some(at) => (&entry[..at], &entry[at + 1..]),
            None => (entry, &[][..]),
        };
        if key.is_empty() {
            continue;
        }
        properties
            .entry(String::from_utf8_lossy(key).to_ascii_lowercase())
            // The first of a key counts, as RFC 6763 §6.4 says
            .or_insert_with(|| String::from_utf8_lossy(value).into_owned());
    }
    properties
}

/// `_home-assistant._tcp.local.` as the service type and the domain apart
fn split_service_type(service_type: &str) -> (&str, &str) {
    match service_type.trim_end_matches('.').rsplit_once('.') {
        Some((regtype, _)) => (regtype, "local."),
        None => (service_type, "local."),
    }
}

fn cstring(text: &str) -> Result<CString> {
    CString::new(text).map_err(|error| Error::Io(std::io::Error::other(error)))
}

/// An error macOS's DNS-SD reported, by its code from dns_sd.h
fn dns_sd_error(operation: &str, status: DnsServiceErrorType) -> Error {
    Error::Io(std::io::Error::other(format!(
        "DNS-SD {operation} failed with {status}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_properties_read_each_key_once() {
        let mut txt = Vec::new();
        for entry in [
            &b"location_name=Home"[..],
            b"UUID=abc",
            b"version=2026.11.0",
            b"requires_api_password",
            b"internal_url=http://192.168.1.20:8123",
            // A later value of the same key doesn't count
            b"uuid=other",
            b"=no key",
            b"",
        ] {
            txt.push(entry.len() as u8);
            txt.extend_from_slice(entry);
        }
        let properties = txt_properties(&txt);
        assert_eq!(properties["location_name"], "Home");
        assert_eq!(properties["uuid"], "abc");
        assert_eq!(properties["requires_api_password"], "");
        assert_eq!(properties["internal_url"], "http://192.168.1.20:8123");
        assert_eq!(properties.len(), 5);
    }

    #[test]
    fn a_cut_off_txt_record_keeps_what_came_before() {
        let txt = b"\x0auuid=abcde\x09version";
        let properties = txt_properties(txt);
        assert_eq!(properties["uuid"], "abcde");
        assert_eq!(properties.len(), 1);
    }

    #[test]
    fn the_service_type_splits_from_its_domain() {
        assert_eq!(
            split_service_type("_home-assistant._tcp.local."),
            ("_home-assistant._tcp", "local.")
        );
    }

    #[test]
    fn an_ipv4_address_reads_from_its_sockaddr() {
        let address = libc::sockaddr_in {
            sin_len: std::mem::size_of::<libc::sockaddr_in>() as u8,
            sin_family: libc::AF_INET as libc::sa_family_t,
            sin_port: 0,
            sin_addr: libc::in_addr {
                s_addr: u32::from_ne_bytes([192, 168, 1, 20]),
            },
            sin_zero: [0; 8],
        };
        let ip = unsafe { ipv4((&raw const address).cast()) };
        assert_eq!(ip, Some(Ipv4Addr::new(192, 168, 1, 20)));
        assert_eq!(unsafe { ipv4(ptr::null()) }, None);
    }
}

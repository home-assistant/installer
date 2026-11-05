//! Requests to a Proxmox server the user is logged in to.

use super::{request_error, tls};
use crate::error::{Error, Result};
use crate::types::ProxmoxSession;
use reqwest::{Method, RequestBuilder, StatusCode};

/// A logged-in Proxmox server. Every request carries the session's ticket, and
/// requests that change something also carry its CSRF token.
pub(super) struct Api<'a> {
    session: &'a ProxmoxSession,
    client: reqwest::Client,
}

impl<'a> Api<'a> {
    /// `timeout_secs` bounds each whole request, its body included.
    pub(super) fn new(session: &'a ProxmoxSession, timeout_secs: u64) -> Result<Self> {
        let client = tls::client(
            &session.server_url,
            session.certificate_sha256.as_deref(),
            timeout_secs,
        )?;
        Ok(Self { session, client })
    }

    /// The URL of `path` in the API, like `/cluster/nextid`.
    pub(super) fn url(&self, path: &str) -> String {
        format!(
            "{}/api2/json{path}",
            self.session.server_url.trim_end_matches('/')
        )
    }

    /// The URL of `path` on `node`, like `/storage`. The node name is encoded
    /// as a path segment.
    pub(super) fn node_url(&self, node: &str, path: &str) -> String {
        self.url(&format!("/nodes/{}{path}", urlencoding::encode(node)))
    }

    pub(super) fn get(&self, url: &str) -> RequestBuilder {
        self.client.get(url).header("Cookie", self.cookie())
    }

    pub(super) fn post(&self, url: &str) -> RequestBuilder {
        self.change(Method::POST, url)
    }

    pub(super) fn put(&self, url: &str) -> RequestBuilder {
        self.change(Method::PUT, url)
    }

    pub(super) fn delete(&self, url: &str) -> RequestBuilder {
        self.change(Method::DELETE, url)
    }

    /// Proxmox refuses a request that changes something without the CSRF token.
    fn change(&self, method: Method, url: &str) -> RequestBuilder {
        self.client
            .request(method, url)
            .header("Cookie", self.cookie())
            .header("CSRFPreventionToken", &self.session.csrf_token)
    }

    fn cookie(&self) -> String {
        format!("PVEAuthCookie={}", self.session.ticket)
    }

    /// GET `url` and parse its JSON answer. `action` names the request in
    /// errors ("Failed to list storage"), `parsing` the parsing of its answer
    /// ("Failed to parse storage list"). A 403 becomes `forbidden` when given,
    /// because Proxmox's own answer doesn't say what to fix.
    pub(super) async fn get_json(
        &self,
        url: &str,
        action: &str,
        parsing: &str,
        forbidden: Option<Error>,
    ) -> Result<serde_json::Value> {
        let response = send(self.get(url), action).await?;
        let status = response.status();
        if let Some(error) = forbidden.filter(|_| status == StatusCode::FORBIDDEN) {
            return Err(error);
        }
        if !status.is_success() {
            return Err(Error::ProxmoxApi(format!("{action}: {status}")));
        }

        response
            .json()
            .await
            .map_err(|error| Error::ProxmoxApi(format!("{parsing}: {error}")))
    }
}

/// Send `request`. A 401 means the ticket expired; every other status is left
/// to the caller.
pub(super) async fn send(request: RequestBuilder, action: &str) -> Result<reqwest::Response> {
    let response = request
        .send()
        .await
        .map_err(|error| request_error(error, action))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(Error::ProxmoxSessionExpired);
    }
    Ok(response)
}

/// Send a request that changes something and return the body of a successful
/// answer. A failure keeps Proxmox's explanation from the body: for these
/// requests it says what went wrong ("storage 'x' does not exist").
pub(super) async fn send_change(request: RequestBuilder, action: &str) -> Result<String> {
    let response = send(request, action).await?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::ProxmoxApi(format!("{action} ({status}): {body}")));
    }
    Ok(body)
}

/// The UPID of the task a request started, from the request's answer.
/// `name` names the request in errors, like "VM creation".
pub(super) fn task_upid(body: &str, name: &str) -> Result<String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| Error::ProxmoxApi(format!("Failed to parse {name} response: {error}")))?;
    json.get("data")
        .and_then(serde_json::Value::as_str)
        .filter(|upid| !upid.is_empty())
        .map(str::to_string)
        .ok_or_else(|| Error::ProxmoxApi(format!("The {name} response has no task UPID")))
}

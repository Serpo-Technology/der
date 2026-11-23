//! Outbound HTTP requests. A caller describes a resolved request and names
//! the credential it needs; the secret is looked up here, checked against
//! the address it was saved for, injected, and never returned.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::confine;
use crate::store::{part_secret_key, saved_for_service, StoredIntegrations};

const MAX_TIMEOUT_SECS: u64 = 120;

/// One resolved request: placeholders already substituted, inputs already
/// split into query pairs or a JSON body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    pub timeout_secs: u64,
    #[serde(default)]
    pub auth: Auth,
}

/// Which stored secret the request carries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Auth {
    /// No secret. Redirects are followed anywhere.
    #[default]
    None,
    /// A named integration credential. Its record decides the service
    /// address and how the secret is placed.
    Credential { name: String },
    /// The secrets of an integration part. The caller states the service
    /// its verified manifest declares and how each secret is placed; a
    /// secret is used only when its record was saved for that service.
    Part {
        fragment_id: String,
        base_url: String,
        #[serde(default)]
        secrets: Vec<PartSecret>,
    },
}

/// One credential requirement of an integration part.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartSecret {
    pub name: String,
    /// "bearer" | "header" | "query"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The name the part's own screens use for this credential.
    pub label: String,
}

/// The response as received: the caller decides what a status means and
/// how the body parses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// How one secret is placed on the request.
enum Placement {
    Bearer(String),
    Header(String, String),
    Query(String, String),
}

/// The outcome of resolving `Auth` against the store.
struct Confined {
    /// The service address the request and its redirects stay inside.
    base: String,
    placements: Vec<Placement>,
    /// Contract credentials place their query secret ahead of the request's
    /// own query pairs; part secrets follow them.
    secret_first: bool,
}

fn placement(kind: &str, target: Option<&str>, secret: &str) -> Option<Placement> {
    match kind {
        "bearer" => Some(Placement::Bearer(secret.to_string())),
        "header" => Some(Placement::Header(
            target.unwrap_or("x-api-key").to_string(),
            secret.to_string(),
        )),
        "query" => Some(Placement::Query(
            target.unwrap_or("key").to_string(),
            secret.to_string(),
        )),
        _ => None,
    }
}

fn resolve(
    integrations: &StoredIntegrations,
    url: &str,
    auth: &Auth,
) -> Result<Option<Confined>, String> {
    match auth {
        Auth::None => Ok(None),
        Auth::Credential { name } => {
            let credential = integrations.credentials.get(name).ok_or_else(|| {
                format!(
                    "No integration credential named \"{}\"; add it in Settings under Integrations",
                    name
                )
            })?;
            match credential.kind.as_str() {
                "bearer" | "header" | "query" => {}
                "smtp" => {
                    return Err(format!(
                        "\"{}\" is a mail account; it can only be used by email.send, never sent to an HTTP endpoint",
                        name
                    ))
                }
                other => return Err(format!("Unknown credential kind \"{}\"", other)),
            }
            // Records saved before the service address became required have
            // none, and a secret without one has nowhere it may go.
            let base = credential
                .base_url
                .as_deref()
                .filter(|base| !base.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "Credential \"{}\" has no service address; edit it in Settings under Integrations and add the address it belongs to",
                        name
                    )
                })?;
            if !confine::within_base(url, base) {
                return Err(format!(
                    "Credential \"{}\" is confined to {}; refusing to send it to {}",
                    name, base, url
                ));
            }
            let placements =
                placement(&credential.kind, credential.target.as_deref(), &credential.secret)
                    .into_iter()
                    .collect();
            Ok(Some(Confined {
                base: base.to_string(),
                placements,
                secret_first: true,
            }))
        }
        Auth::Part {
            fragment_id,
            base_url,
            secrets,
        } => {
            if !confine::within_base(url, base_url) {
                return Err("Endpoint escaped the service".to_string());
            }
            let mut placements = Vec::new();
            for requirement in secrets {
                let record = integrations
                    .credentials
                    .get(&part_secret_key(fragment_id, &requirement.name))
                    .ok_or_else(|| {
                        format!(
                            "This part needs its \"{}\" credential; add it in the Parts view",
                            requirement.label
                        )
                    })?;
                // A secret travels only to the address it was saved for. An
                // update that moves the part to another service leaves the
                // record behind.
                if !saved_for_service(record, base_url) {
                    return Err(format!(
                        "The \"{}\" credential was saved for another service address; enter it again in the Parts view",
                        requirement.label
                    ));
                }
                placements.extend(placement(
                    &requirement.kind,
                    requirement.target.as_deref(),
                    &record.secret,
                ));
            }
            Ok(Some(Confined {
                base: base_url.clone(),
                placements,
                secret_first: false,
            }))
        }
    }
}

/// Sends one request. Every refusal happens before a connection opens.
pub async fn perform(
    integrations: &StoredIntegrations,
    request: HttpRequest,
) -> Result<HttpReply, String> {
    let url = request.url.as_str();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Remote endpoint must be an http(s) URL: {}", url));
    }
    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("Unsupported HTTP method: {}", other)),
    };
    let confined = resolve(integrations, url, &request.auth)?;

    // A real User-Agent on every request: services like Wikipedia answer
    // 403 to anonymous clients, and reqwest sends no default.
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(request.timeout_secs.clamp(1, MAX_TIMEOUT_SECS)))
        .user_agent(concat!(
            "DER/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/Serpo-Technology/der)"
        ));
    if let Some(confined) = &confined {
        builder = builder.redirect(confine::redirect_policy(&confined.base));
    }
    let client = builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut outgoing = client.request(method, url);
    for (name, value) in &request.headers {
        outgoing = outgoing.header(name, value);
    }
    let placements = confined.as_ref().map(|c| c.placements.as_slice()).unwrap_or(&[]);
    let secret_first = confined.as_ref().is_some_and(|c| c.secret_first);
    let mut secret_query: Vec<(&str, &str)> = Vec::new();
    for placement in placements {
        match placement {
            Placement::Bearer(secret) => {
                outgoing = outgoing.header("authorization", format!("Bearer {}", secret));
            }
            Placement::Header(target, secret) => {
                outgoing = outgoing.header(target, secret);
            }
            Placement::Query(target, secret) => secret_query.push((target, secret)),
        }
    }
    if secret_first && !secret_query.is_empty() {
        outgoing = outgoing.query(&secret_query);
    }
    if !request.query.is_empty() {
        outgoing = outgoing.query(&request.query);
    }
    if !secret_first && !secret_query.is_empty() {
        outgoing = outgoing.query(&secret_query);
    }
    if let Some(body) = &request.json {
        outgoing = outgoing.json(body);
    }

    // With a confined request, failures are described without the request
    // URL: a query-parameter credential is part of it.
    let describe = |error: reqwest::Error| match &confined {
        Some(_) => confine::describe_send_error(error),
        None => error.to_string(),
    };
    let response = outgoing
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", describe(e)))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", describe(e)))?;
    Ok(HttpReply { status, body })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    use super::{perform, Auth, HttpReply, HttpRequest, PartSecret};
    use crate::store::{part_secret_key, IntegrationCredential, StoredIntegrations};

    const SECRET: &str = "s3cret-value";
    const PART: &str = "labs.weather";

    fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let origin = format!("http://{}", listener.local_addr().expect("local addr"));
        (listener, origin)
    }

    /// Answers one connection per scripted response and returns the raw
    /// requests it received, lowercased.
    fn serve(listener: TcpListener, responses: Vec<String>) -> JoinHandle<Vec<String>> {
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut chunk).expect("read request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                }
                stream.write_all(response.as_bytes()).expect("write response");
                requests.push(String::from_utf8_lossy(&request).to_lowercase());
            }
            requests
        })
    }

    fn redirect_to(location: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            location
        )
    }

    fn json_ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn record(kind: &str, base_url: Option<String>) -> IntegrationCredential {
        IntegrationCredential {
            kind: kind.to_string(),
            target: Some(if kind == "query" { "key" } else { "x-api-key" }.to_string()),
            base_url,
            notes: None,
            fields: None,
            secret: SECRET.to_string(),
        }
    }

    fn stored(kind: &str, base_url: Option<String>) -> StoredIntegrations {
        let mut integrations = StoredIntegrations::default();
        integrations
            .credentials
            .insert("svc".to_string(), record(kind, base_url));
        integrations
    }

    fn integrations(kind: &str, base_url: &str) -> StoredIntegrations {
        stored(kind, Some(base_url.to_string()))
    }

    fn get(url: &str, auth: Auth) -> HttpRequest {
        HttpRequest {
            method: "GET".to_string(),
            url: url.to_string(),
            headers: Vec::new(),
            query: Vec::new(),
            json: None,
            timeout_secs: 15,
            auth,
        }
    }

    fn run(integrations: &StoredIntegrations, request: HttpRequest) -> Result<HttpReply, String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(perform(integrations, request))
    }

    fn call(url: &str, integrations: &StoredIntegrations) -> Result<HttpReply, String> {
        run(integrations, get(url, Auth::Credential { name: "svc".to_string() }))
    }

    fn part_auth(base_url: &str, kind: &str) -> Auth {
        Auth::Part {
            fragment_id: PART.to_string(),
            base_url: base_url.to_string(),
            secrets: vec![PartSecret {
                name: "api-key".to_string(),
                kind: kind.to_string(),
                target: Some("appid".to_string()),
                label: "API key".to_string(),
            }],
        }
    }

    fn part_store(base_url: Option<String>) -> StoredIntegrations {
        let mut integrations = StoredIntegrations::default();
        integrations
            .credentials
            .insert(part_secret_key(PART, "api-key"), record("partsecret", base_url));
        integrations
    }

    fn no_connection(listener: &TcpListener) {
        let attempt = listener.accept();
        assert!(
            matches!(&attempt, Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the host saw a connection: {attempt:?}"
        );
    }

    #[test]
    fn a_host_that_only_begins_with_the_base_gets_no_request() {
        let integrations = integrations("header", "https://api.service.dev");
        let error = call("https://api.service.dev.elsewhere.net/v1", &integrations)
            .expect_err("the lookalike host is refused");
        assert!(error.contains("is confined to https://api.service.dev"), "{error}");
    }

    #[test]
    fn a_credential_without_a_service_address_gets_no_request() {
        let (service, origin) = listener();
        service.set_nonblocking(true).expect("nonblocking");
        for base_url in [None, Some(String::new()), Some("  ".to_string())] {
            let error = call(&format!("{origin}/data"), &stored("header", base_url))
                .expect_err("the secret has nowhere it may go");
            assert!(error.contains("has no service address"), "{error}");
        }
        no_connection(&service);
    }

    #[test]
    fn mail_and_part_secrets_are_refused_as_named_credentials() {
        let mail = call("https://api.service.dev/v1", &stored("smtp", None))
            .expect_err("a mail account is never sent over HTTP");
        assert!(mail.contains("is a mail account"), "{mail}");
        let part = call(
            "https://api.service.dev/v1",
            &stored("partsecret", Some("https://api.service.dev".to_string())),
        )
        .expect_err("a part secret belongs to its part");
        assert!(part.contains("Unknown credential kind"), "{part}");
    }

    #[test]
    fn a_redirect_inside_the_service_is_followed_with_the_secret() {
        let (service, origin) = listener();
        let server = serve(service, vec![redirect_to("/next"), json_ok("{\"ok\":true}")]);
        let reply = call(&format!("{origin}/start"), &integrations("header", &origin))
            .expect("the request completes");
        assert_eq!(reply, HttpReply { status: 200, body: "{\"ok\":true}".to_string() });
        let requests = server.join().expect("server thread");
        assert!(requests[1].starts_with("get /next "), "{}", requests[1]);
        assert!(requests[1].contains(&format!("x-api-key: {SECRET}")), "{}", requests[1]);
    }

    #[test]
    fn a_redirect_leaving_the_service_is_refused_before_it_connects() {
        let (service, origin) = listener();
        let (outside, outside_origin) = listener();
        outside.set_nonblocking(true).expect("nonblocking");
        let server = serve(service, vec![redirect_to(&format!("{outside_origin}/collect"))]);
        let error = call(&format!("{origin}/start"), &integrations("header", &origin))
            .expect_err("the redirect is refused");
        assert!(error.contains("redirected the request outside"), "{error}");
        server.join().expect("server thread");
        no_connection(&outside);
    }

    #[test]
    fn a_failed_request_never_puts_a_query_secret_in_its_message() {
        let (closed, origin) = listener();
        drop(closed);
        let error = call(&format!("{origin}/data"), &integrations("query", &origin))
            .expect_err("nothing listens there");
        assert!(error.starts_with("Request failed:"), "{error}");
        assert!(!error.contains(SECRET), "{error}");
    }

    #[test]
    fn a_request_without_a_credential_follows_redirects_anywhere() {
        let (service, origin) = listener();
        let (other, other_origin) = listener();
        let first = serve(service, vec![redirect_to(&format!("{other_origin}/moved"))]);
        let second = serve(other, vec![json_ok("{\"moved\":true}")]);
        let reply = run(&StoredIntegrations::default(), get(&format!("{origin}/start"), Auth::None))
            .expect("the redirect is followed");
        assert_eq!(reply.body, "{\"moved\":true}");
        first.join().expect("first server");
        let requests = second.join().expect("second server");
        assert!(requests[0].contains("user-agent: der/"), "{}", requests[0]);
    }

    #[test]
    fn the_reply_carries_the_status_and_body_as_received() {
        let (service, origin) = listener();
        let server = serve(
            service,
            vec!["HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\nConnection: close\r\n\r\ngone".to_string()],
        );
        let reply = run(&StoredIntegrations::default(), get(&format!("{origin}/x"), Auth::None))
            .expect("a status is a reply");
        assert_eq!(reply, HttpReply { status: 404, body: "gone".to_string() });
        server.join().expect("server thread");
    }

    #[test]
    fn query_pairs_and_a_json_body_travel_with_the_request() {
        let (service, origin) = listener();
        let server = serve(service, vec![json_ok("{}")]);
        let mut request = get(&format!("{origin}/items"), Auth::None);
        request.method = "post".to_string();
        request.headers = vec![("x-trace".to_string(), "abc".to_string())];
        request.query = vec![("q".to_string(), "a b".to_string())];
        request.json = Some(serde_json::json!({ "n": 1 }));
        run(&StoredIntegrations::default(), request).expect("sends");
        let requests = server.join().expect("server thread");
        assert!(requests[0].starts_with("post /items?q=a+b "), "{}", requests[0]);
        assert!(requests[0].contains("x-trace: abc"), "{}", requests[0]);
        assert!(requests[0].contains("content-type: application/json"), "{}", requests[0]);
    }

    #[test]
    fn a_part_secret_is_sent_to_the_service_it_was_saved_for() {
        let (service, origin) = listener();
        let server = serve(service, vec![json_ok("{\"temp\":4}")]);
        let mut request = get(&format!("{origin}/data"), part_auth(&origin, "query"));
        request.query = vec![("q".to_string(), "oslo".to_string())];
        let reply = run(&part_store(Some(origin.clone())), request).expect("sends");
        assert_eq!(reply.body, "{\"temp\":4}");
        let requests = server.join().expect("server thread");
        assert!(
            requests[0].starts_with(&format!("get /data?q=oslo&appid={SECRET} ")),
            "{}",
            requests[0]
        );
    }

    #[test]
    fn a_part_secret_saved_for_another_address_is_not_sent() {
        let (service, origin) = listener();
        service.set_nonblocking(true).expect("nonblocking");
        let url = format!("{origin}/data");
        for saved in [None, Some("https://api.elsewhere.dev".to_string()), Some(format!("{origin}.elsewhere.dev"))] {
            let error = run(&part_store(saved.clone()), get(&url, part_auth(&origin, "bearer")))
                .expect_err("the record does not belong to this service");
            assert!(error.contains("saved for another service address"), "{saved:?}: {error}");
        }
        let missing = run(&StoredIntegrations::default(), get(&url, part_auth(&origin, "bearer")))
            .expect_err("no record at all");
        assert!(missing.contains("needs its \"API key\" credential"), "{missing}");
        no_connection(&service);
    }

    #[test]
    fn a_part_request_stays_inside_its_service() {
        let (service, origin) = listener();
        let (outside, outside_origin) = listener();
        outside.set_nonblocking(true).expect("nonblocking");
        let escaped = run(
            &part_store(Some(origin.clone())),
            get(&format!("{outside_origin}/data"), part_auth(&origin, "header")),
        )
        .expect_err("the url is outside the service");
        assert_eq!(escaped, "Endpoint escaped the service");

        let server = serve(service, vec![redirect_to(&format!("{outside_origin}/collect"))]);
        let redirected = run(
            &part_store(Some(origin.clone())),
            get(&format!("{origin}/data"), part_auth(&origin, "header")),
        )
        .expect_err("the redirect is refused");
        assert!(redirected.contains("redirected the request outside"), "{redirected}");
        server.join().expect("server thread");
        no_connection(&outside);
    }

    #[test]
    fn only_http_urls_and_known_methods_are_sent() {
        let empty = StoredIntegrations::default();
        let scheme = run(&empty, get("file:///etc/hosts", Auth::None)).expect_err("scheme");
        assert!(scheme.contains("must be an http(s) URL"), "{scheme}");
        let mut request = get("https://api.service.dev/x", Auth::None);
        request.method = "TRACE".to_string();
        let method = run(&empty, request).expect_err("method");
        assert_eq!(method, "Unsupported HTTP method: TRACE");
    }
}

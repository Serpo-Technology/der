//! Base-URL confinement for requests that carry a stored secret. A secret
//! travels only to the service it was saved for: the request URL has to sit
//! at or under the service base URL, and so does every redirect the client
//! follows. The contract remote path and the integration part path both
//! decide through this module.

use reqwest::redirect::Policy;
use reqwest::Url;

use crate::runtime::validation::endpoint_within_base;

const MAX_REDIRECTS: usize = 10;

/// Whether `url` is the service at `base` or a path under it. The textual
/// rule the validator teaches runs first; the parsed comparison then pins
/// scheme, host, and port, refuses embedded user info, and compares the
/// path after dot segments resolve, so "/v1/../admin" is outside "/v1".
pub fn within_base(url: &str, base: &str) -> bool {
    if !endpoint_within_base(url, base) {
        return false;
    }
    match (Url::parse(url), Url::parse(base)) {
        (Ok(url), Ok(base)) => parsed_within(&url, &base),
        _ => false,
    }
}

fn parsed_within(url: &Url, base: &Url) -> bool {
    if !matches!(base.scheme(), "http" | "https") || url.origin() != base.origin() {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let base_path = base.path().trim_end_matches('/');
    let path = url.path();
    path == base_path
        || path
            .strip_prefix(base_path)
            .is_some_and(|tail| tail.starts_with('/'))
}

/// The scheme, host, and port of `url`, used as the redirect scope for a
/// credential saved without a base URL.
pub fn origin_of(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

/// Follows a redirect only while it stays inside `scope`. Without a usable
/// scope no redirect is followed.
pub fn redirect_policy(scope: Option<&str>) -> Policy {
    let scope = scope.and_then(|base| Url::parse(base).ok());
    Policy::custom(move |attempt| {
        let inside = scope
            .as_ref()
            .is_some_and(|base| parsed_within(attempt.url(), base));
        if !inside {
            attempt.error("the redirect leaves the service")
        } else if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// The message for a failed send on a request that carried a secret. The
/// URL is dropped from the text because a query-parameter credential is
/// part of it.
pub fn describe_send_error(error: reqwest::Error) -> String {
    if error.is_redirect() {
        return "The service redirected the request outside its own address, so it was stopped"
            .to_string();
    }
    error.without_url().to_string()
}

#[cfg(test)]
mod tests {
    use super::{origin_of, within_base};

    const BASE: &str = "https://api.service.dev";

    #[test]
    fn accepts_the_base_and_anything_under_it() {
        for url in [
            "https://api.service.dev",
            "https://api.service.dev/",
            "https://api.service.dev/v1/items",
            "https://api.service.dev?q=1",
            "https://api.service.dev/v1/items?q=1#top",
        ] {
            assert!(within_base(url, BASE), "{url}");
            assert!(within_base(url, "https://api.service.dev/"), "{url} with a trailing slash base");
        }
    }

    #[test]
    fn refuses_hosts_that_only_begin_with_the_base() {
        for url in [
            "https://api.service.dev.elsewhere.net/v1",
            "https://api.service.development/v1",
            "https://api.service.dev@elsewhere.net/v1",
            "https://api.service.dev:8443/v1",
            "https://api.service.dev\\@elsewhere.net/v1",
            "https://api.service.dev\t.elsewhere.net/v1",
            "https://api.service.dev%2eelsewhere.net/v1",
        ] {
            assert!(!within_base(url, BASE), "{url}");
        }
    }

    #[test]
    fn refuses_another_scheme_or_embedded_user_info() {
        assert!(!within_base("http://api.service.dev/v1", BASE));
        assert!(!within_base("https://user:pw@api.service.dev/v1", BASE));
        assert!(!within_base("ftp://api.service.dev/v1", "ftp://api.service.dev"));
    }

    #[test]
    fn a_base_path_confines_by_whole_segments() {
        let base = "https://api.service.dev/v1";
        assert!(within_base("https://api.service.dev/v1", base));
        assert!(within_base("https://api.service.dev/v1/items", base));
        assert!(!within_base("https://api.service.dev/v1beta/items", base));
        assert!(!within_base("https://api.service.dev/v2/items", base));
        assert!(!within_base("https://api.service.dev/v1/../admin", base));
        assert!(!within_base("https://api.service.dev/v1/%2e%2e/admin", base));
    }

    #[test]
    fn a_malformed_base_confines_to_nothing() {
        for base in ["", "https://", "api.service.dev", "https://a.dev?x", "https://u@a.dev"] {
            assert!(!within_base("https://api.service.dev/v1", base), "base {base:?}");
            assert!(!within_base(base, base), "base {base:?} against itself");
        }
    }

    #[test]
    fn origin_keeps_scheme_host_and_port_only() {
        assert_eq!(
            origin_of("http://127.0.0.1:8080/a/b?c=d").as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(origin_of("file:///etc/hosts"), None);
        assert_eq!(origin_of("not a url"), None);
    }
}

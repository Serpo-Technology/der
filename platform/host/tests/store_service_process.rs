//! The store service as a real process: the host executable started with
//! `--service store`, driven through the client the app uses.

use std::time::Duration;

use der_store::{Reply, Request};
use serde_json::{json, Value};

type Client = der_wire::Client<Request, Reply>;

const HOST: &str = env!("CARGO_BIN_EXE_dynamic-experience-runtime");
const WAIT: Duration = Duration::from_secs(60);

fn put(experience_id: &str, title: &str) -> Request {
    Request::Put {
        experience_id: experience_id.to_string(),
        collection: "notes".to_string(),
        record: json!({ "title": title }).as_object().cloned().unwrap(),
    }
}

fn all(experience_id: &str) -> Request {
    Request::Query {
        experience_id: experience_id.to_string(),
        collection: "notes".to_string(),
        field: String::new(),
        equals: Value::Null,
        contains: String::new(),
        sort_by: "title".to_string(),
        direction: String::new(),
        limit: String::new(),
        offset: String::new(),
    }
}

fn outputs(reply: Reply) -> Value {
    match reply {
        Reply::Outputs(outputs) => outputs,
        Reply::Error(message) => panic!("an error: {message}"),
    }
}

#[test]
fn records_are_kept_by_the_service_per_app_and_outlive_its_process() {
    let stores = tempfile::tempdir().expect("temp dir");
    let client = Client::new("store", HOST, der_wire::service_arguments("store", stores.path()));
    assert_eq!(client.process_id(), None, "nothing runs before the first request");

    outputs(client.call(put("app-1", "beta"), WAIT).expect("answers"));
    outputs(client.call(put("app-1", "alpha"), WAIT).expect("answers"));
    outputs(client.call(put("app-2", "theirs"), WAIT).expect("answers"));
    assert_ne!(client.process_id(), Some(std::process::id()));

    let mine = outputs(client.call(all("app-1"), WAIT).expect("answers"));
    assert_eq!(mine["total"], 2);
    assert_eq!(mine["items"][0]["title"], "alpha", "sorted by title");
    assert_eq!(outputs(client.call(all("app-2"), WAIT).expect("answers"))["total"], 1);
    assert!(stores.path().join("app-1").join("notes.json").is_file());

    // A fresh process finds the same records on disk.
    drop(client);
    let again = Client::new("store", HOST, der_wire::service_arguments("store", stores.path()));
    assert_eq!(outputs(again.call(all("app-1"), WAIT).expect("answers"))["total"], 2);
}

#[test]
fn a_request_without_a_proper_app_is_refused() {
    let stores = tempfile::tempdir().expect("temp dir");
    let client = Client::new("store", HOST, der_wire::service_arguments("store", stores.path()));
    for experience_id in ["", "../elsewhere", "a/b"] {
        let reply = client.call(put(experience_id, "x"), WAIT).expect("answers");
        assert!(
            matches!(reply, Reply::Error(ref message) if message.contains("needs its owning app")),
            "{experience_id:?}: {reply:?}"
        );
    }
    assert_eq!(std::fs::read_dir(stores.path()).expect("stores").count(), 0);
}

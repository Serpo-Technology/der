//! DER's store service: the per-app record stores, for data that outgrows
//! an app's state (archives, journals, libraries). Each app has its own
//! folder of collections and every request names the app it is for, so
//! one app's records are never read or written on behalf of another. The
//! caller says which app that is; a session never does. Requests are
//! answered one at a time in the order they arrive, so two writes to a
//! collection never overwrite each other. The crate has no dependency on
//! the desktop shell.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod records;

/// Everything the service does for a caller. `experience_id` is the app
/// the request is for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// Save one record: a matching "id" replaces in place, anything else
    /// is added with a generated id. Answers {record, count}.
    Put {
        experience_id: String,
        collection: String,
        record: Map<String, Value>,
    },
    /// Read a collection with an optional single filter (equals or
    /// contains on one field), an optional sort, and paging. Answers
    /// {items, count, total}.
    Query {
        experience_id: String,
        collection: String,
        #[serde(default)]
        field: String,
        #[serde(default)]
        equals: Value,
        #[serde(default)]
        contains: String,
        #[serde(default)]
        sort_by: String,
        #[serde(default)]
        direction: String,
        #[serde(default)]
        limit: String,
        #[serde(default)]
        offset: String,
    },
    /// Remove the record with the given id. Answers {removed, count}.
    Remove {
        experience_id: String,
        collection: String,
        id: String,
    },
}

/// The answer to a `Request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "data", rename_all = "camelCase")]
pub enum Reply {
    /// The operation's outputs.
    Outputs(Value),
    Error(String),
}

/// What a line that is not a request is answered with.
const UNREADABLE: &str = "The request could not be read";

/// The service over the folder that holds every app's store.
pub struct Service {
    stores_dir: PathBuf,
}

impl Service {
    pub fn new(stores_dir: impl Into<PathBuf>) -> Self {
        Service {
            stores_dir: stores_dir.into(),
        }
    }

    pub fn handle(&self, request: Request) -> Reply {
        let base = self.stores_dir.as_path();
        let outcome = match request {
            Request::Put {
                experience_id,
                collection,
                record,
            } => records::put_core(base, &experience_id, &collection, &record, || {
                uuid::Uuid::new_v4().to_string()
            }),
            Request::Query {
                experience_id,
                collection,
                field,
                equals,
                contains,
                sort_by,
                direction,
                limit,
                offset,
            } => records::query_core(
                base,
                &experience_id,
                &collection,
                &field,
                &equals,
                &contains,
                &sort_by,
                &direction,
                &limit,
                &offset,
            ),
            Request::Remove {
                experience_id,
                collection,
                id,
            } => records::remove_core(base, &experience_id, &collection, &id),
        };
        match outcome {
            Ok(outputs) => Reply::Outputs(outputs),
            Err(message) => Reply::Error(message),
        }
    }
}

/// Serves requests over the stores folder until the input closes, one at
/// a time in the order they arrive.
pub fn serve<R, W>(stores_dir: impl Into<PathBuf>, input: R, output: W) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let service = Service::new(stores_dir);
    der_wire::serve(
        input,
        output,
        || Reply::Error(UNREADABLE.to_string()),
        |request: Request, responder: der_wire::Responder<Reply>| responder.answer(service.handle(request)),
    )
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use serde_json::json;

    use super::*;

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
            sort_by: String::new(),
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
    fn each_app_reads_and_writes_only_its_own_records() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path());
        let saved = outputs(service.handle(put("app-1", "first")));
        assert_eq!(saved["count"], 1);
        let id = saved["record"]["id"].as_str().expect("a generated id").to_string();
        outputs(service.handle(put("app-2", "theirs")));

        let mine = outputs(service.handle(all("app-1")));
        assert_eq!(mine["total"], 1);
        assert_eq!(mine["items"][0]["title"], "first");

        // Another app naming the same collection and id touches nothing here.
        let removed = outputs(service.handle(Request::Remove {
            experience_id: "app-2".to_string(),
            collection: "notes".to_string(),
            id: id.clone(),
        }));
        assert_eq!(removed["removed"], false);
        assert_eq!(outputs(service.handle(all("app-1")))["total"], 1);

        let removed = outputs(service.handle(Request::Remove {
            experience_id: "app-1".to_string(),
            collection: "notes".to_string(),
            id,
        }));
        assert_eq!(removed["removed"], true);
        assert_eq!(outputs(service.handle(all("app-1")))["total"], 0);
        assert_eq!(outputs(service.handle(all("app-2")))["total"], 1);
    }

    #[test]
    fn an_app_name_that_could_leave_the_stores_folder_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = Service::new(dir.path().join("stores"));
        for experience_id in ["", "../elsewhere", "a/b", "..", "app 1"] {
            let reply = service.handle(put(experience_id, "x"));
            assert!(
                matches!(reply, Reply::Error(ref message) if message.contains("needs its owning app")),
                "{experience_id:?}: {reply:?}"
            );
        }
        let bad_collection = service.handle(Request::Put {
            experience_id: "app-1".to_string(),
            collection: "../notes".to_string(),
            record: Map::new(),
        });
        assert!(matches!(bad_collection, Reply::Error(ref message) if message.contains("Collection names")));
        let entries: Vec<_> = std::fs::read_dir(dir.path()).expect("dir").flatten().collect();
        assert!(
            entries.iter().all(|entry| entry.file_name() == "stores"),
            "nothing was written outside the stores folder"
        );
    }

    #[test]
    fn requests_and_replies_survive_a_line_of_json() {
        let line = serde_json::to_string(&put("app-1", "first")).expect("serializes");
        assert!(line.contains("\"op\":\"put\""), "{line}");
        assert!(line.contains("\"experienceId\":\"app-1\""), "{line}");
        let back: Request = serde_json::from_str(&line).expect("parses");
        assert_eq!(serde_json::to_string(&back).expect("serializes"), line);
        let query: Request = serde_json::from_str(
            r#"{"op":"query","experienceId":"app-1","collection":"notes","sortBy":"title"}"#,
        )
        .expect("a query with everything else left out");
        assert!(matches!(query, Request::Query { ref sort_by, ref equals, .. } if sort_by == "title" && equals.is_null()));
        for reply in [Reply::Outputs(json!({ "count": 1 })), Reply::Error("refused".into())] {
            let line = serde_json::to_string(&reply).expect("serializes");
            assert_eq!(serde_json::from_str::<Reply>(&line).expect("parses"), reply);
        }
    }

    #[test]
    fn the_service_answers_over_its_pipes_in_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (request_reader, mut requests) = std::io::pipe().expect("pipe");
        let (replies, reply_writer) = std::io::pipe().expect("pipe");
        let stores = dir.path().to_path_buf();
        let thread = std::thread::spawn(move || serve(stores, BufReader::new(request_reader), reply_writer));
        let mut replies = BufReader::new(replies);
        for (id, request) in [(1, put("app-1", "a")), (2, put("app-1", "b")), (3, all("app-1"))] {
            let line = serde_json::to_string(&der_wire::RequestLine { id, request }).expect("serializes");
            writeln!(requests, "{line}").expect("writes");
        }
        let mut read = || -> der_wire::ReplyLine<Reply> {
            let mut line = String::new();
            replies.read_line(&mut line).expect("reads");
            serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
        };
        assert_eq!(read().id, 1);
        assert_eq!(read().id, 2);
        let listed = read();
        assert_eq!(listed.id, 3);
        assert_eq!(outputs(listed.reply)["total"], 2);
        drop(requests);
        thread.join().expect("no panic").expect("ends cleanly when the input closes");
    }
}

//! The service's end of the line protocol.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::{ReplyLine, RequestLine};

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// Answers one request. It can cross to another thread or task, so a
/// handler may answer a slow request after later ones.
pub struct Responder<P> {
    id: u64,
    output: Output,
    reply: std::marker::PhantomData<fn(P)>,
}

impl<P: Serialize> Responder<P> {
    /// Writes the reply as one line. A reply that cannot be written is
    /// dropped: the reader is gone, and the input closes next.
    pub fn answer(self, reply: P) {
        let Ok(mut line) = serde_json::to_string(&ReplyLine { id: self.id, reply }) else {
            return;
        };
        line.push('\n');
        let mut output = self.output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = output.write_all(line.as_bytes());
        let _ = output.flush();
    }
}

/// Reads requests from `input` until it closes and hands each to `handle`
/// with the responder for its id. Requests reach `handle` in the order they
/// arrive, on the calling thread. A line that carries an id but is not a
/// request is answered with `unreadable()`, whose text is the caller's and
/// never the line's, since the line may hold a secret. A line without an id
/// has no reply to address and is skipped.
pub fn serve<R, P, In, Out>(
    input: In,
    output: Out,
    unreadable: impl Fn() -> P,
    mut handle: impl FnMut(R, Responder<P>),
) -> std::io::Result<()>
where
    R: DeserializeOwned,
    P: Serialize,
    In: BufRead,
    Out: Write + Send + 'static,
{
    let output: Output = Arc::new(Mutex::new(Box::new(output)));
    let responder = |id: u64| Responder {
        id,
        output: output.clone(),
        reply: std::marker::PhantomData,
    };
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<RequestLine<R>>(&line) {
            Ok(RequestLine { id, request }) => handle(request, responder(id)),
            Err(_) => {
                if let Some(id) = line_id(&line) {
                    responder(id).answer(unreadable());
                }
            }
        }
    }
    Ok(())
}

fn line_id(line: &str) -> Option<u64> {
    serde_json::from_str::<Value>(line).ok()?.get("id")?.as_u64()
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use serde::{Deserialize, Serialize};

    use super::*;

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "op", rename_all = "camelCase")]
    enum Ask {
        Double { value: i64 },
        Later { value: i64 },
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "reply", content = "data", rename_all = "camelCase")]
    enum Answer {
        Number(i64),
        Error(String),
    }

    /// Runs the loop on a thread over two pipes and returns the caller's
    /// ends. Requests marked `Later` are answered from their own thread
    /// after a pause.
    fn running() -> (std::io::PipeWriter, BufReader<std::io::PipeReader>, std::thread::JoinHandle<std::io::Result<()>>) {
        let (request_reader, requests) = std::io::pipe().expect("pipe");
        let (replies, reply_writer) = std::io::pipe().expect("pipe");
        let thread = std::thread::spawn(move || {
            serve(
                BufReader::new(request_reader),
                reply_writer,
                || Answer::Error("unreadable".to_string()),
                |ask: Ask, responder: Responder<Answer>| match ask {
                    Ask::Double { value } => responder.answer(Answer::Number(value * 2)),
                    Ask::Later { value } => {
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            responder.answer(Answer::Number(value));
                        });
                    }
                },
            )
        });
        (requests, BufReader::new(replies), thread)
    }

    fn next(replies: &mut BufReader<std::io::PipeReader>) -> ReplyLine<Answer> {
        let mut line = String::new();
        replies.read_line(&mut line).expect("reads");
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line:?}"))
    }

    #[test]
    fn replies_carry_the_id_of_their_request() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":7,"request":{{"op":"double","value":4}}}}"#).expect("writes");
        writeln!(requests).expect("writes");
        writeln!(requests, r#"{{"id":8,"request":{{"op":"double","value":-1}}}}"#).expect("writes");
        assert_eq!(next(&mut replies), ReplyLine { id: 7, reply: Answer::Number(8) });
        assert_eq!(next(&mut replies), ReplyLine { id: 8, reply: Answer::Number(-2) });
        drop(requests);
        thread.join().expect("no panic").expect("ends cleanly when the input closes");
    }

    #[test]
    fn a_slow_request_is_answered_after_a_later_quick_one() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":1,"request":{{"op":"later","value":5}}}}"#).expect("writes");
        writeln!(requests, r#"{{"id":2,"request":{{"op":"double","value":5}}}}"#).expect("writes");
        assert_eq!(next(&mut replies), ReplyLine { id: 2, reply: Answer::Number(10) });
        assert_eq!(next(&mut replies), ReplyLine { id: 1, reply: Answer::Number(5) });
        drop(requests);
        thread.join().expect("no panic").expect("ends");
    }

    #[test]
    fn a_line_that_is_not_a_request_is_refused_without_echoing_it() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":3,"request":{{"op":"double","value":"s3cret-value"}}}}"#).expect("writes");
        writeln!(requests, "not json at all").expect("writes");
        writeln!(requests, r#"{{"id":4,"request":{{"op":"double","value":1}}}}"#).expect("writes");
        assert_eq!(
            next(&mut replies),
            ReplyLine { id: 3, reply: Answer::Error("unreadable".to_string()) }
        );
        // The line without an id had no reply to address.
        assert_eq!(next(&mut replies), ReplyLine { id: 4, reply: Answer::Number(2) });
        drop(requests);
        thread.join().expect("no panic").expect("ends");
    }
}

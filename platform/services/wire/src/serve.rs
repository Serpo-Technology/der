//! The service's end of the line protocol.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::{FailedLine, PartLine, ReplyLine, RequestLine};

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// Answers one request. It can cross to another thread or task, so a
/// handler may answer a slow request after later ones. One that is dropped
/// without answering, as when its handler panics, tells the caller the
/// request failed.
pub struct Responder<P> {
    id: u64,
    output: Output,
    answered: bool,
    reply: std::marker::PhantomData<fn(P)>,
}

impl<P> Drop for Responder<P> {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        let failed = FailedLine {
            id: self.id,
            failed: true,
        };
        if let Ok(line) = serde_json::to_string(&failed) {
            write_line(&self.output, line);
        }
    }
}

fn write_line(output: &Output, mut line: String) {
    line.push('\n');
    let mut output = output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = output.write_all(line.as_bytes());
    let _ = output.flush();
}

impl<P: Serialize> Responder<P> {
    /// Writes the reply as one line. A reply that cannot be written is
    /// dropped: the reader is gone, and the input closes next.
    pub fn answer(mut self, reply: P) {
        if let Ok(line) = serde_json::to_string(&ReplyLine { id: self.id, reply }) {
            self.answered = true;
            write_line(&self.output, line);
        }
    }

    /// Writes one piece of a streamed reply. The reply itself still has to
    /// be given with `answer`.
    pub fn part(&self, text: &str) {
        let part = PartLine {
            id: self.id,
            part: text.to_string(),
        };
        if let Ok(line) = serde_json::to_string(&part) {
            write_line(&self.output, line);
        }
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
        answered: false,
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
        Spell { word: String },
        Panic,
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
                    Ask::Spell { word } => {
                        for letter in word.chars() {
                            responder.part(&letter.to_string());
                        }
                        responder.answer(Answer::Number(word.chars().count() as i64));
                    }
                    Ask::Panic => {
                        std::thread::spawn(move || {
                            let _held = responder;
                            panic!("the handler fell over");
                        });
                    }
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
    fn a_streamed_reply_sends_its_parts_before_the_reply() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":5,"request":{{"op":"spell","word":"ab"}}}}"#).expect("writes");
        let mut lines = Vec::new();
        for _ in 0..3 {
            let mut line = String::new();
            replies.read_line(&mut line).expect("reads");
            lines.push(line.trim_end().to_string());
        }
        assert_eq!(lines[0], r#"{"id":5,"part":"a"}"#);
        assert_eq!(lines[1], r#"{"id":5,"part":"b"}"#);
        assert_eq!(lines[2], r#"{"id":5,"reply":{"reply":"number","data":2}}"#);
        drop(requests);
        thread.join().expect("no panic").expect("ends");
    }

    #[test]
    fn a_handler_that_ends_without_answering_reports_the_failure() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":6,"request":{{"op":"panic"}}}}"#).expect("writes");
        let mut line = String::new();
        replies.read_line(&mut line).expect("reads");
        assert_eq!(line.trim_end(), r#"{"id":6,"failed":true}"#);
        writeln!(requests, r#"{{"id":7,"request":{{"op":"double","value":1}}}}"#).expect("writes");
        assert_eq!(next(&mut replies), ReplyLine { id: 7, reply: Answer::Number(2) });
        drop(requests);
        thread.join().expect("no panic").expect("ends");
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

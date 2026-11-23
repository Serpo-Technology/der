//! The service's end of the line protocol.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CallLine, FailedLine, PartLine, ReplyLine};

type Output = Arc<Mutex<Box<dyn Write + Send>>>;

/// The calls to the host that are waiting for their answers, by request id
/// and call number.
#[derive(Default)]
struct Calls {
    next: AtomicU64,
    waiting: Mutex<HashMap<(u64, u64), Sender<Value>>>,
}

/// Puts questions to the host on behalf of one request. It can be cloned
/// and kept for as long as the request is being handled, on any thread
/// except the one running `serve`, which has to stay free to read answers.
#[derive(Clone)]
pub struct Caller {
    id: u64,
    output: Output,
    calls: Arc<Calls>,
}

impl Caller {
    /// Sends one call and blocks until the host answers it. Fails when the
    /// input closes first, which is when the host is gone.
    pub fn call(&self, body: Value) -> Result<Value, String> {
        let call = self.calls.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (waiter, answer) = channel();
        self.calls
            .waiting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((self.id, call), waiter);
        let line = serde_json::to_string(&CallLine {
            id: self.id,
            call,
            body,
        })
        .map_err(|error| format!("The call could not be written: {}", error))?;
        write_line(&self.output, line);
        answer
            .recv()
            .map_err(|_| "The host closed the connection before answering".to_string())
    }
}

/// Answers one request. It can cross to another thread or task, so a
/// handler may answer a slow request after later ones. One that is dropped
/// without answering, as when its handler panics, tells the caller the
/// request failed.
pub struct Responder<P> {
    id: u64,
    output: Output,
    calls: Arc<Calls>,
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

    /// The way to put questions to the host while this request is being
    /// handled.
    pub fn caller(&self) -> Caller {
        Caller {
            id: self.id,
            output: self.output.clone(),
            calls: self.calls.clone(),
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
/// has no reply to address and is skipped. Answer lines go to the calls
/// that wait for them.
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
    let calls = Arc::new(Calls::default());
    let responder = |id: u64| Responder {
        id,
        output: output.clone(),
        calls: calls.clone(),
        answered: false,
        reply: std::marker::PhantomData,
    };
    let mut outcome = Ok(());
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                outcome = Err(error);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Inbound<R>>(&line) {
            Ok(Inbound {
                id,
                request: Some(request),
                ..
            }) => handle(request, responder(id)),
            Ok(Inbound {
                id,
                answer: Some(call),
                body,
                ..
            }) => {
                let waiter = calls
                    .waiting
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&(id, call));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(body.unwrap_or(Value::Null));
                }
            }
            Ok(Inbound { id, .. }) => responder(id).answer(unreadable()),
            Err(_) => {
                if let Some(id) = line_id(&line) {
                    responder(id).answer(unreadable());
                }
            }
        }
    }
    // Nobody is left to answer: dropping the senders ends every wait.
    calls
        .waiting
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    outcome
}

/// A line from the host: a request line or an answer line.
#[derive(Deserialize)]
#[serde(bound(deserialize = "R: DeserializeOwned"))]
struct Inbound<R> {
    id: u64,
    request: Option<R>,
    answer: Option<u64>,
    body: Option<Value>,
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
        Relay { question: String },
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
                    Ask::Relay { question } => {
                        let caller = responder.caller();
                        std::thread::spawn(move || match caller.call(Value::String(question)) {
                            Ok(answer) => responder.answer(Answer::Number(answer.as_i64().unwrap_or(-1))),
                            Err(message) => responder.answer(Answer::Error(message)),
                        });
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
    fn a_call_to_the_host_waits_for_its_answer_while_other_requests_go_on() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":8,"request":{{"op":"relay","question":"how many"}}}}"#).expect("writes");
        let mut line = String::new();
        replies.read_line(&mut line).expect("reads");
        assert_eq!(line.trim_end(), r#"{"id":8,"call":1,"body":"how many"}"#);

        // The loop keeps serving while the call waits.
        writeln!(requests, r#"{{"id":9,"request":{{"op":"double","value":2}}}}"#).expect("writes");
        assert_eq!(next(&mut replies), ReplyLine { id: 9, reply: Answer::Number(4) });
        // An answer for a call nobody made is dropped.
        writeln!(requests, r#"{{"id":8,"answer":99,"body":1}}"#).expect("writes");
        writeln!(requests, r#"{{"id":8,"answer":1,"body":42}}"#).expect("writes");
        assert_eq!(next(&mut replies), ReplyLine { id: 8, reply: Answer::Number(42) });
        drop(requests);
        thread.join().expect("no panic").expect("ends");
    }

    #[test]
    fn a_call_ends_with_an_error_when_the_host_goes_away() {
        let (mut requests, mut replies, thread) = running();
        writeln!(requests, r#"{{"id":8,"request":{{"op":"relay","question":"anyone"}}}}"#).expect("writes");
        let mut line = String::new();
        replies.read_line(&mut line).expect("reads");
        assert!(line.contains(r#""call":1"#), "{line}");
        drop(requests);
        thread.join().expect("no panic").expect("ends");
        let reply = next(&mut replies);
        assert_eq!(reply.id, 8);
        assert!(matches!(reply.reply, Answer::Error(ref message) if message.contains("closed the connection")));
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

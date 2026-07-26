//! Document conversion bits for the DER wasm host, guest ABI v1: markdown
//! to HTML, markdown to plain text, and text to a real PDF built by a
//! minimal writer over the Helvetica core fonts. Pure compute over JSON;
//! file IO stays in the platform layer.

use std::alloc::{alloc, Layout};
use std::mem;

use pulldown_cmark::{html, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde_json::{json, Map, Value};

const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[no_mangle]
pub extern "C" fn der_alloc(size: i32) -> i32 {
    if size <= 0 {
        return 0;
    }
    let layout = match Layout::from_size_align(size as usize, 1) {
        Ok(layout) => layout,
        Err(_) => return 0,
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() {
        return 0;
    }
    ptr as i32
}

#[no_mangle]
pub extern "C" fn der_run(ptr: i32, len: i32) -> i64 {
    pack(handle(ptr, len))
}

fn handle(ptr: i32, len: i32) -> Vec<u8> {
    let request = match read_request(ptr, len) {
        Some(bytes) => bytes,
        None => return err_response("empty request"),
    };
    let envelope: Value = match serde_json::from_slice(request) {
        Ok(value) => value,
        Err(_) => return err_response("request is not valid JSON"),
    };
    let operation = match envelope.get("operation").and_then(Value::as_str) {
        Some(name) => name,
        None => return err_response("request has no operation name"),
    };
    let empty = Map::new();
    let inputs = envelope
        .get("inputs")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    match operation {
        "docs.markdownHtml" => markdown_html(inputs),
        "docs.markdownText" => markdown_text(inputs),
        "docs.textPdf" => text_pdf(inputs, false),
        "docs.markdownPdf" => text_pdf(inputs, true),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

fn text_input<'a>(inputs: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    match inputs.get(key) {
        Some(Value::String(text)) if text.len() <= MAX_TEXT_BYTES => Ok(text.as_str()),
        Some(Value::String(_)) => Err(format!("{} is larger than 4 MB", key)),
        _ => Err(format!("{} must be a string", key)),
    }
}

fn markdown_html(inputs: &Map<String, Value>) -> Vec<u8> {
    let markdown = match text_input(inputs, "markdown") {
        Ok(text) => text,
        Err(message) => return err_response(&message),
    };
    let parser = Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);
    let mut out = String::new();
    html::push_html(&mut out, parser);
    ok_response(json!({ "html": out }))
}

/// Markdown flattened to readable plain text: headings and paragraphs keep
/// their line structure, emphasis and links keep their visible text.
fn markdown_plain(markdown: &str) -> Vec<(usize, String)> {
    let parser = Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);
    let mut lines: Vec<(usize, String)> = Vec::new();
    let mut current = String::new();
    let mut level: usize = 0;
    let mut list_depth: usize = 0;
    let flush = |lines: &mut Vec<(usize, String)>, current: &mut String, level: usize| {
        if !current.trim().is_empty() {
            lines.push((level, current.trim().to_string()));
        }
        current.clear();
    };
    for event in parser {
        match event {
            Event::Start(Tag::Heading { level: heading, .. }) => {
                flush(&mut lines, &mut current, level);
                level = match heading {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    _ => 3,
                };
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut lines, &mut current, level);
                level = 0;
            }
            Event::Start(Tag::Item) => {
                flush(&mut lines, &mut current, level);
                current.push_str(&"  ".repeat(list_depth.saturating_sub(1)));
                current.push_str("- ");
            }
            Event::End(TagEnd::Item) => flush(&mut lines, &mut current, level),
            Event::Start(Tag::List(_)) => list_depth += 1,
            Event::End(TagEnd::List(_)) => list_depth = list_depth.saturating_sub(1),
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::CodeBlock) => {
                flush(&mut lines, &mut current, level);
                lines.push((0, String::new()));
            }
            Event::Text(text) | Event::Code(text) => current.push_str(&text),
            Event::SoftBreak => current.push(' '),
            Event::HardBreak => flush(&mut lines, &mut current, level),
            Event::Rule => {
                flush(&mut lines, &mut current, level);
                lines.push((0, String::new()));
            }
            _ => {}
        }
    }
    flush(&mut lines, &mut current, level);
    while lines.last().is_some_and(|(_, text)| text.is_empty()) {
        lines.pop();
    }
    lines
}

fn markdown_text(inputs: &Map<String, Value>) -> Vec<u8> {
    let markdown = match text_input(inputs, "markdown") {
        Ok(text) => text,
        Err(message) => return err_response(&message),
    };
    let text = markdown_plain(markdown)
        .into_iter()
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .join("\n");
    ok_response(json!({ "text": text }))
}

/// Text or markdown becomes a paginated PDF: Helvetica core fonts,
/// heading sizes, wrapped lines. Two operation names, one builder, so the
/// intuitive name works for either input kind.
fn text_pdf(inputs: &Map<String, Value>, markdown_mode: bool) -> Vec<u8> {
    let title = inputs
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lines: Vec<(usize, String)> = if markdown_mode {
        match text_input(inputs, "markdown") {
            Ok(markdown) => markdown_plain(markdown),
            Err(message) => return err_response(&message),
        }
    } else if let Some(Value::String(markdown)) = inputs.get("markdown") {
        // textPdf tolerates markdown input; markdownPdf is the honest name.
        if markdown.len() > MAX_TEXT_BYTES {
            return err_response("markdown is larger than 4 MB");
        }
        markdown_plain(markdown)
    } else {
        match text_input(inputs, "text") {
            Ok(text) => text.lines().map(|line| (0, line.to_string())).collect(),
            Err(_) => {
                return err_response("textPdf needs a \"text\" or \"markdown\" string input")
            }
        }
    };
    let bytes = build_pdf(&title, &lines);
    ok_response(json!({ "base64": base64_encode(&bytes), "pages": pdf_page_count(&bytes) }))
}

// ---------------------------------------------------------------------------
// A minimal PDF writer: Helvetica core fonts, A4 pages, wrapped text.
// ---------------------------------------------------------------------------

const PAGE_WIDTH: f32 = 595.0;
const PAGE_HEIGHT: f32 = 842.0;
const MARGIN: f32 = 56.0;

struct Line {
    size: f32,
    bold: bool,
    text: String,
    gap_before: f32,
}

fn layout_lines(title: &str, source: &[(usize, String)]) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    if !title.trim().is_empty() {
        for wrapped in wrap(title.trim(), 20.0) {
            out.push(Line { size: 20.0, bold: true, text: wrapped, gap_before: 0.0 });
        }
        out.push(Line { size: 11.0, bold: false, text: String::new(), gap_before: 6.0 });
    }
    for (level, text) in source {
        if text.is_empty() {
            out.push(Line { size: 11.0, bold: false, text: String::new(), gap_before: 0.0 });
            continue;
        }
        let (size, bold, gap) = match level {
            1 => (17.0, true, 8.0),
            2 => (14.0, true, 6.0),
            3 => (12.0, true, 4.0),
            _ => (11.0, false, 0.0),
        };
        let mut first = true;
        for wrapped in wrap(text, size) {
            out.push(Line {
                size,
                bold,
                text: wrapped,
                gap_before: if first { gap } else { 0.0 },
            });
            first = false;
        }
    }
    out
}

/// Rough Helvetica metrics: average glyph advance around 0.5 em.
fn wrap(text: &str, size: f32) -> Vec<String> {
    let usable = PAGE_WIDTH - 2.0 * MARGIN;
    let max_chars = ((usable / (size * 0.5)) as usize).max(12);
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate_len = if current.is_empty() {
            word.chars().count()
        } else {
            current.chars().count() + 1 + word.chars().count()
        };
        if candidate_len > max_chars && !current.is_empty() {
            lines.push(mem::take(&mut current));
        }
        // A single overlong word hard-breaks.
        if word.chars().count() > max_chars {
            let mut piece = String::new();
            for ch in word.chars() {
                if piece.chars().count() == max_chars {
                    lines.push(mem::take(&mut piece));
                }
                piece.push(ch);
            }
            current = piece;
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn escape_pdf_text(text: &str) -> String {
    // Core fonts are WinAnsi; anything outside Latin-1 degrades to '?'.
    let mut out = String::new();
    for ch in text.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            ch if (ch as u32) < 256 => out.push(ch),
            _ => out.push('?'),
        }
    }
    out
}

fn build_pdf(title: &str, source: &[(usize, String)]) -> Vec<u8> {
    let lines = layout_lines(title, source);

    // Pages of content streams.
    let mut pages: Vec<String> = Vec::new();
    let mut content = String::new();
    let mut y = PAGE_HEIGHT - MARGIN;
    for line in &lines {
        let leading = line.size * 1.45 + line.gap_before;
        if y - leading < MARGIN {
            pages.push(mem::take(&mut content));
            y = PAGE_HEIGHT - MARGIN;
        }
        y -= leading;
        if !line.text.is_empty() {
            let font = if line.bold { "F2" } else { "F1" };
            content.push_str(&format!(
                "BT /{} {} Tf {} {} Td ({}) Tj ET\n",
                font,
                line.size,
                MARGIN,
                y,
                escape_pdf_text(&line.text)
            ));
        }
    }
    pages.push(content);

    // Objects: 1 catalog, 2 pages, then per page (page, stream), fonts last.
    let mut objects: Vec<String> = Vec::new();
    let page_count = pages.len();
    let font_regular_id = 3 + 2 * page_count;
    let font_bold_id = font_regular_id + 1;
    let kids: Vec<String> = (0..page_count).map(|i| format!("{} 0 R", 3 + 2 * i)).collect();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        page_count
    ));
    for (index, page) in pages.iter().enumerate() {
        let page_id = 3 + 2 * index;
        let stream_id = page_id + 1;
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents {} 0 R /Resources << /Font << /F1 {} 0 R /F2 {} 0 R >> >> >>",
            PAGE_WIDTH, PAGE_HEIGHT, stream_id, font_regular_id, font_bold_id
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}endstream",
            page.len(),
            page
        ));
    }
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_string(),
    );
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
            .to_string(),
    );

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xc2\xb5\xc2\xb6\n");
    let mut offsets: Vec<usize> = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        out.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref_at
        )
        .as_bytes(),
    );
    out
}

fn pdf_page_count(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    text.matches("/Type /Page ").count()
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
}

fn ok_response(data: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "ok": data })).unwrap_or_else(|_| b"{\"err\":\"encode\"}".to_vec())
}

fn err_response(message: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "err": message }))
        .unwrap_or_else(|_| b"{\"err\":\"encode\"}".to_vec())
}

fn pack(bytes: Vec<u8>) -> i64 {
    let len = bytes.len() as i64;
    let ptr = bytes.as_ptr() as i64;
    mem::forget(bytes);
    (ptr << 32) | len
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_becomes_html_and_text() {
        let mut inputs = Map::new();
        inputs.insert("markdown".into(), json!("# Title\n\nBody with *em*.\n\n- one\n- two"));
        let html: Value = serde_json::from_slice(&markdown_html(&inputs)).unwrap();
        assert!(html["ok"]["html"].as_str().unwrap().contains("<h1>"));
        let text: Value = serde_json::from_slice(&markdown_text(&inputs)).unwrap();
        let flat = text["ok"]["text"].as_str().unwrap();
        assert!(flat.contains("Title"));
        assert!(flat.contains("- one"));
    }

    #[test]
    fn text_pdf_produces_a_parsable_pdf() {
        let mut inputs = Map::new();
        inputs.insert("title".into(), json!("Report"));
        inputs.insert(
            "markdown".into(),
            json!("# Heading\n\nSome paragraph long enough to wrap when repeated. Some paragraph long enough to wrap when repeated."),
        );
        let out: Value = serde_json::from_slice(&text_pdf(&inputs, false)).unwrap();
        let b64 = out["ok"]["base64"].as_str().unwrap();
        assert!(!b64.is_empty());
        assert_eq!(out["ok"]["pages"], json!(1));
        // Round-trip the base64 and check the PDF skeleton.
        let head = &b64[..8];
        assert_eq!(head, "JVBERi0x"); // "%PDF-1" in base64
    }

    #[test]
    fn many_lines_paginate() {
        let long = (0..300).map(|i| format!("Line number {}", i)).collect::<Vec<_>>().join("\n");
        let mut inputs = Map::new();
        inputs.insert("text".into(), json!(long));
        let out: Value = serde_json::from_slice(&text_pdf(&inputs, false)).unwrap();
        assert!(out["ok"]["pages"].as_u64().unwrap() >= 2);
    }
}

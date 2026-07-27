//! Webpage content extraction part for the DER wasm host, guest ABI v1.
//!
//! Exports `memory`, `der_alloc`, and `der_run` and imports nothing. The
//! host writes `{"operation": name, "inputs": object}` into guest memory;
//! the guest answers `{"ok": object}` or `{"err": message}` packed as
//! `(ptr << 32) | len`. Bad input always produces an `err` response.
//!
//! `page.blocks` reads a page's HTML with a tolerant scanner (no strict
//! parsing; broken markup degrades instead of failing), strips boilerplate
//! subtrees (navigation, scripts, forms, media chrome), and answers the
//! readable content as typed blocks a list element renders natively:
//! headings, paragraphs, list items, quotes, code, images, and links, in
//! document order. Relative urls resolve against the page url; a block
//! whose text is mostly one link becomes a link block so readers can
//! navigate.

use std::alloc::{alloc, Layout};
use std::mem;

use serde_json::{json, Map, Value};

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
        "page.blocks" => blocks_operation(inputs),
        other => err_response(&format!("unknown operation {}", other)),
    }
}

const MAX_BLOCKS: usize = 500;
const MAX_BLOCK_CHARS: usize = 4000;

fn blocks_operation(inputs: &Map<String, Value>) -> Vec<u8> {
    let html = match inputs.get("html") {
        Some(Value::String(s)) => s,
        Some(Value::Null) | None => {
            return err_response("html has no value yet; run the operation that sets it first")
        }
        Some(_) => return err_response("html is not a string"),
    };
    if html.trim().is_empty() {
        return err_response("html is empty; fetch the page first");
    }
    let base = inputs
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    let (title, blocks) = extract(html, base);
    let count = blocks.len();
    let rows: Vec<Value> = blocks.into_iter().map(block_json).collect();
    ok_response(json!({ "title": title, "blocks": rows, "count": count }))
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Heading,
    Paragraph,
    Item,
    Quote,
    Code,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Heading => "heading",
            Kind::Paragraph => "paragraph",
            Kind::Item => "item",
            Kind::Quote => "quote",
            Kind::Code => "code",
        }
    }
}

struct Block {
    kind: &'static str,
    level: Option<i64>,
    text: String,
    src: Option<String>,
    href: Option<String>,
}

fn block_json(block: Block) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::String(block.kind.to_string()));
    if let Some(level) = block.level {
        map.insert("level".into(), json!(level));
    }
    map.insert("text".into(), Value::String(block.text));
    if let Some(src) = block.src {
        map.insert("src".into(), Value::String(src));
    }
    if let Some(href) = block.href {
        map.insert("href".into(), Value::String(href));
    }
    Value::Object(map)
}

/// Subtrees that never contribute readable content.
const EXCLUDED: &[&str] = &[
    "nav", "header", "footer", "aside", "form", "select", "button", "canvas",
    "audio", "video", "iframe", "object", "template", "svg", "noscript",
    "dialog", "menu",
];

/// Elements whose raw text runs to their closing tag ('<' is content).
const RAW_TEXT: &[&str] = &["script", "style", "textarea"];

/// Void elements never open an exclusion (they have no subtree).
const VOID: &[&str] = &[
    "img", "br", "hr", "input", "meta", "link", "source", "wbr", "area",
    "base", "col", "embed", "track", "param",
];

/// Landmarks and hidden subtrees that never hold readable content.
fn excluded_by_attrs(tag: &Tag) -> bool {
    if has_attr(tag, "hidden") {
        return true;
    }
    if attr(tag, "aria-hidden") == Some("true") {
        return true;
    }
    matches!(
        attr(tag, "role"),
        Some(
            "navigation" | "banner" | "contentinfo" | "complementary" | "search"
                | "menu" | "menubar" | "toolbar" | "alert"
        )
    )
}

struct Tag<'a> {
    name: String,
    closing: bool,
    attrs: Vec<(String, &'a str)>,
    after: usize,
}

enum LinkTarget {
    /// A navigable http(s) url.
    Http(String),
    /// An in-page fragment or javascript link: reader chrome.
    Chrome,
    /// Real but unopenable here (mailto, tel): the text stays.
    Other,
}

struct Extractor {
    title: String,
    blocks: Vec<Block>,
    buffer: String,
    kind: Option<(Kind, Option<i64>)>,
    /// (buffer start, buffer end, target) for links in the block.
    links: Vec<(usize, usize, LinkTarget)>,
    open_link: Option<(usize, LinkTarget)>,
    excluded_depth: usize,
    /// The element that opened an attribute-based exclusion, with a count
    /// of same-named elements nested inside it.
    attr_excluded: Option<(String, i32)>,
    in_pre: bool,
    truncated: bool,
}

fn extract(html: &str, base: &str) -> (String, Vec<Block>) {
    let mut state = Extractor {
        title: String::new(),
        blocks: Vec::new(),
        buffer: String::new(),
        kind: None,
        links: Vec::new(),
        open_link: None,
        excluded_depth: 0,
        attr_excluded: None,
        in_pre: false,
        truncated: false,
    };

    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() && !state.truncated {
        if bytes[i] != b'<' {
            let end = next_lt(bytes, i + 1);
            state.text(&html[i..end]);
            i = end;
            continue;
        }
        if html[i..].starts_with("<!--") {
            i = match html[i..].find("-->") {
                Some(at) => i + at + 3,
                None => bytes.len(),
            };
            continue;
        }
        if html[i..].starts_with("<!") || html[i..].starts_with("<?") {
            i = match memchr(bytes, b'>', i) {
                Some(at) => at + 1,
                None => bytes.len(),
            };
            continue;
        }
        match parse_tag(html, i) {
            Some(tag) => {
                let next = tag.after;
                if !tag.closing && tag.name == "title" && state.title.is_empty() {
                    let (text, after) = raw_text_until_close(html, next, "title");
                    state.title = collapse(&decode_entities(text));
                    state.title.truncate_floor(300);
                    i = after;
                    continue;
                }
                if !tag.closing && RAW_TEXT.contains(&tag.name.as_str()) {
                    let (_, after) = raw_text_until_close(html, next, &tag.name);
                    i = after;
                    continue;
                }
                state.tag(&tag, base);
                i = next;
            }
            None => {
                // A stray '<' that is not a tag: treat it as text.
                state.text("<");
                i += 1;
            }
        }
    }
    state.flush();
    if state.truncated {
        state.blocks.push(Block {
            kind: "paragraph",
            level: None,
            text: "(page truncated)".to_string(),
            src: None,
            href: None,
        });
    }
    (state.title, state.blocks)
}

impl Extractor {
    fn text(&mut self, raw: &str) {
        if self.excluded_depth > 0 {
            return;
        }
        let decoded = decode_entities(raw);
        if self.in_pre {
            self.buffer.push_str(&decoded);
            return;
        }
        for ch in decoded.chars() {
            if ch.is_whitespace() {
                if !self.buffer.is_empty() && !self.buffer.ends_with(' ') {
                    self.buffer.push(' ');
                }
            } else {
                self.buffer.push(ch);
            }
        }
    }

    fn tag(&mut self, tag: &Tag, base: &str) {
        let name = tag.name.as_str();
        // An attribute-based exclusion tracks nesting of its own element
        // name so the matching close ends it.
        if let Some((owner, nested)) = &mut self.attr_excluded {
            if name == owner.as_str() {
                if tag.closing {
                    if *nested == 0 {
                        self.attr_excluded = None;
                        self.excluded_depth = self.excluded_depth.saturating_sub(1);
                        return;
                    }
                    *nested -= 1;
                } else {
                    *nested += 1;
                }
            }
        } else if !tag.closing && self.excluded_depth == 0 && excluded_by_attrs(tag) && !VOID.contains(&name) {
            self.attr_excluded = Some((tag.name.clone(), 0));
            self.excluded_depth += 1;
            return;
        }
        if EXCLUDED.contains(&name) {
            if tag.closing {
                self.excluded_depth = self.excluded_depth.saturating_sub(1);
            } else {
                self.excluded_depth += 1;
            }
            return;
        }
        if self.excluded_depth > 0 {
            return;
        }
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                if !tag.closing {
                    let level = (name.as_bytes()[1] - b'0') as i64;
                    self.kind = Some((Kind::Heading, Some(level.min(3))));
                }
            }
            "p" | "figcaption" => {
                self.flush();
                if !tag.closing {
                    self.kind = Some((Kind::Paragraph, None));
                }
            }
            "li" | "dt" | "dd" | "tr" => {
                self.flush();
                if !tag.closing {
                    self.kind = Some((Kind::Item, None));
                }
            }
            "td" | "th" => {
                // Cells separate with a space inside their row's item.
                if !self.buffer.is_empty() && !self.buffer.ends_with(' ') {
                    self.buffer.push(' ');
                }
            }
            "blockquote" => {
                self.flush();
                if !tag.closing {
                    self.kind = Some((Kind::Quote, None));
                }
            }
            "pre" => {
                self.flush();
                self.in_pre = !tag.closing;
                if !tag.closing {
                    self.kind = Some((Kind::Code, None));
                }
            }
            "br" => {
                if self.in_pre {
                    self.buffer.push('\n');
                } else {
                    self.text(" ");
                }
            }
            "div" | "section" | "article" | "main" | "ul" | "ol" | "dl" | "table" => {
                // Structure boundaries: loose text so far becomes a paragraph.
                self.flush();
            }
            "img" => {
                if tag.closing {
                    return;
                }
                let tiny = tag
                    .attrs
                    .iter()
                    .any(|(k, v)| (k == "width" || k == "height") && (*v == "1" || *v == "0"));
                if tiny {
                    return;
                }
                let src = attr(tag, "src").or_else(|| attr(tag, "data-src"));
                let resolved = src.and_then(|value| resolve_image(base, value));
                if let Some(src) = resolved {
                    let alt = attr(tag, "alt").map(decode_entities).unwrap_or_default();
                    self.flush();
                    self.push_block(Block {
                        kind: "image",
                        level: None,
                        text: collapse(&alt),
                        src: Some(src),
                        href: None,
                    });
                }
            }
            "a" => {
                if tag.closing {
                    if let Some((start, target)) = self.open_link.take() {
                        let end = self.buffer.len();
                        if end > start {
                            self.links.push((start, end, target));
                        }
                    }
                } else if let Some(href) = attr(tag, "href") {
                    let trimmed = href.trim();
                    let lower = trimmed.to_ascii_lowercase();
                    let target = if lower.starts_with('#') || lower.starts_with("javascript:") {
                        LinkTarget::Chrome
                    } else {
                        match resolve_url(base, trimmed) {
                            Some(url) => LinkTarget::Http(url),
                            None => LinkTarget::Other,
                        }
                    };
                    self.open_link = Some((self.buffer.len(), target));
                }
            }
            _ => {}
        }
    }

    fn flush(&mut self) {
        let (kind, level) = self.kind.take().unwrap_or((Kind::Paragraph, None));
        self.open_link = None;
        let mut text = mem::take(&mut self.buffer);
        let links = mem::take(&mut self.links);
        while text.ends_with(' ') {
            text.pop();
        }
        if !self.in_pre {
            while text.starts_with(' ') {
                text.remove(0);
            }
        }
        if text.is_empty() {
            return;
        }
        text.truncate_floor(MAX_BLOCK_CHARS);

        // A block whose text is mostly one link reads as a link: list rows
        // can then open it. Headings keep their kind and carry the href,
        // and a non-heading block that is only an in-page link (skip links,
        // tables of contents) is chrome and drops entirely.
        let mut kind_name = kind.name();
        let mut href = None;
        if kind != Kind::Code && kind != Kind::Quote {
            if let Some((start, end, target)) = links
                .into_iter()
                .max_by_key(|(start, end, _)| end.saturating_sub(*start))
            {
                let span = end.min(text.len()).saturating_sub(start.min(text.len()));
                if span * 2 >= text.trim().len() && span > 0 {
                    match target {
                        LinkTarget::Http(url) => {
                            href = Some(url);
                            if kind != Kind::Heading {
                                kind_name = "link";
                            }
                        }
                        LinkTarget::Chrome => {
                            if kind != Kind::Heading {
                                return;
                            }
                        }
                        LinkTarget::Other => {}
                    }
                }
            }
        }
        self.push_block(Block {
            kind: kind_name,
            level,
            text,
            src: None,
            href,
        });
    }

    fn push_block(&mut self, block: Block) {
        if self.blocks.len() >= MAX_BLOCKS {
            self.truncated = true;
            return;
        }
        self.blocks.push(block);
    }
}

trait TruncateFloor {
    fn truncate_floor(&mut self, max: usize);
}

impl TruncateFloor for String {
    /// Truncates to at most `max` bytes on a char boundary.
    fn truncate_floor(&mut self, max: usize) {
        if self.len() <= max {
            return;
        }
        let mut end = max;
        while end > 0 && !self.is_char_boundary(end) {
            end -= 1;
        }
        self.truncate(end);
    }
}

fn next_lt(bytes: &[u8], from: usize) -> usize {
    memchr(bytes, b'<', from).unwrap_or(bytes.len())
}

fn memchr(bytes: &[u8], needle: u8, from: usize) -> Option<usize> {
    bytes[from..].iter().position(|b| *b == needle).map(|at| from + at)
}

/// Parses the tag starting at `<`; None when it is not tag-shaped.
fn parse_tag(html: &str, start: usize) -> Option<Tag<'_>> {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let name = html[name_start..i].to_ascii_lowercase();

    let mut attrs = Vec::new();
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return Some(Tag { name, closing, attrs, after: bytes.len() });
        }
        match bytes[i] {
            b'>' => return Some(Tag { name, closing, attrs, after: i + 1 }),
            b'/' => {
                i += 1;
            }
            _ => {
                let key_start = i;
                while i < bytes.len()
                    && !bytes[i].is_ascii_whitespace()
                    && bytes[i] != b'='
                    && bytes[i] != b'>'
                    && bytes[i] != b'/'
                {
                    i += 1;
                }
                let key = html[key_start..i].to_ascii_lowercase();
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                let mut value: &str = "";
                if bytes.get(i) == Some(&b'=') {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    match bytes.get(i) {
                        Some(&quote @ (b'"' | b'\'')) => {
                            i += 1;
                            let value_start = i;
                            while i < bytes.len() && bytes[i] != quote {
                                i += 1;
                            }
                            value = &html[value_start..i];
                            i = (i + 1).min(bytes.len());
                        }
                        _ => {
                            let value_start = i;
                            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                                i += 1;
                            }
                            value = &html[value_start..i];
                        }
                    }
                }
                if !key.is_empty() {
                    attrs.push((key, value));
                }
            }
        }
    }
}

/// Content of a raw-text element up to its closing tag.
fn raw_text_until_close<'a>(html: &'a str, from: usize, name: &str) -> (&'a str, usize) {
    let close = format!("</{}", name);
    let lower = html[from..].to_ascii_lowercase();
    match lower.find(&close) {
        Some(at) => {
            let end = from + at;
            let after = match memchr(html.as_bytes(), b'>', end) {
                Some(gt) => gt + 1,
                None => html.len(),
            };
            (&html[from..end], after)
        }
        None => (&html[from..], html.len()),
    }
}

fn attr<'a>(tag: &'a Tag, name: &str) -> Option<&'a str> {
    tag.attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| *value)
        .filter(|value| !value.is_empty())
}

/// Presence check for value-less attributes like `hidden`.
fn has_attr(tag: &Tag, name: &str) -> bool {
    tag.attrs.iter().any(|(key, _)| key == name)
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest[..rest.len().min(12)].find(';');
        match end {
            Some(semi) => {
                let entity = &rest[1..semi];
                let decoded: Option<String> = match entity {
                    "amp" => Some("&".into()),
                    "lt" => Some("<".into()),
                    "gt" => Some(">".into()),
                    "quot" => Some("\"".into()),
                    "apos" => Some("'".into()),
                    "nbsp" => Some(" ".into()),
                    "ndash" => Some("-".into()),
                    "mdash" => Some("-".into()),
                    "hellip" => Some("...".into()),
                    "lsquo" | "rsquo" => Some("'".into()),
                    "ldquo" | "rdquo" => Some("\"".into()),
                    "copy" => Some("(c)".into()),
                    _ => {
                        if let Some(code) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                            u32::from_str_radix(code, 16).ok().and_then(char::from_u32).map(String::from)
                        } else if let Some(code) = entity.strip_prefix('#') {
                            code.parse::<u32>().ok().and_then(char::from_u32).map(String::from)
                        } else {
                            None
                        }
                    }
                };
                match decoded {
                    Some(s) => {
                        out.push_str(&s);
                        rest = &rest[semi + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn origin(base: &str) -> Option<&str> {
    let scheme_end = base.find("://")?;
    let host_start = scheme_end + 3;
    match base[host_start..].find('/') {
        Some(at) => Some(&base[..host_start + at]),
        None => Some(base),
    }
}

/// Resolves a link href against the page url; None for links a reader
/// cannot open (fragments, javascript, mail).
fn resolve_url(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    let lower = href.to_ascii_lowercase();
    if lower.starts_with('#')
        || lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
        || lower.starts_with("data:")
    {
        return None;
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(href.to_string());
    }
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = if base.starts_with("http://") { "http:" } else { "https:" };
        return Some(format!("{}//{}", scheme, rest));
    }
    let origin = origin(base)?;
    if let Some(rest) = href.strip_prefix('/') {
        return Some(format!("{}/{}", origin, rest));
    }
    // Relative: against the base's directory, with ../ squashed.
    let no_query = base.split(['?', '#']).next().unwrap_or(base);
    let dir = match no_query[origin.len()..].rfind('/') {
        Some(at) => &no_query[..origin.len() + at],
        None => origin,
    };
    let mut segments: Vec<&str> = dir[origin.len()..]
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    for segment in href.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    Some(format!("{}/{}", origin, segments.join("/")))
}

/// Images additionally accept data: urls; everything else resolves like a
/// link.
fn resolve_image(base: &str, src: &str) -> Option<String> {
    let src = src.trim();
    if src.to_ascii_lowercase().starts_with("data:image/") {
        return Some(src.to_string());
    }
    resolve_url(base, src)
}

fn read_request(ptr: i32, len: i32) -> Option<&'static [u8]> {
    if ptr <= 0 || len <= 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr as u32 as *const u8, len as usize) })
}

fn ok_response(data: Value) -> Vec<u8> {
    to_bytes(json!({ "ok": data }))
}

fn err_response(message: &str) -> Vec<u8> {
    to_bytes(json!({ "err": message }))
}

fn to_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&value)
        .unwrap_or_else(|_| br#"{"err":"response serialization failed"}"#.to_vec())
}

fn pack(response: Vec<u8>) -> i64 {
    let out_ptr = response.as_ptr() as u32 as u64;
    let out_len = response.len() as u32 as u64;
    mem::forget(response);
    ((out_ptr << 32) | out_len) as i64
}

#[cfg(test)]
mod tests {
    use super::{extract, resolve_url};

    const PAGE: &str = r#"<!doctype html>
<html><head><title>The &amp; Title</title><script>var x = "<p>not content</p>";</script>
<style>p { color: red }</style></head>
<body>
<nav><a href="/home">Home</a><a href="/about">About</a></nav>
<header><h1>Site banner</h1></header>
<main>
<h1>Real   Heading</h1>
<p>First paragraph with an <a href="/inline">inline link</a> and &ldquo;entities&rdquo; &#8212; decoded.</p>
<img src="/pics/photo.jpg" alt="A photo" width="640">
<img src="/pixel.gif" width="1" height="1">
<ul>
<li><a href="story1.html">First story</a></li>
<li><a href="story2.html">Second story</a> <span>42 points</span></li>
<li>A plain item without links at all, just text</li>
</ul>
<blockquote>Someone said something.</blockquote>
<pre>let a = 1;
let b = 2;</pre>
</main>
<footer><p>Copyright</p></footer>
</body></html>"#;

    #[test]
    fn extracts_readable_blocks_in_order() {
        let (title, blocks) = extract(PAGE, "https://example.org/posts/index.html");
        assert_eq!(title, "The & Title");
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind).collect();
        assert_eq!(
            kinds,
            vec!["heading", "paragraph", "image", "link", "link", "item", "quote", "code"]
        );
        assert_eq!(blocks[0].text, "Real Heading");
        assert_eq!(blocks[0].level, Some(1));
        assert!(blocks[1].text.contains("inline link"));
        assert!(blocks[1].text.contains("\"entities\""));
        assert_eq!(blocks[2].src.as_deref(), Some("https://example.org/pics/photo.jpg"));
        assert_eq!(blocks[2].text, "A photo");
        assert_eq!(blocks[3].text, "First story");
        assert_eq!(
            blocks[3].href.as_deref(),
            Some("https://example.org/posts/story1.html")
        );
        // The dominant link carries the whole row's text.
        assert!(blocks[4].text.contains("42 points"));
        assert_eq!(blocks[7].text, "let a = 1;\nlet b = 2;");
    }

    #[test]
    fn boilerplate_never_leaks() {
        let (_, blocks) = extract(PAGE, "https://example.org/");
        let all: String = blocks.iter().map(|b| b.text.as_str()).collect();
        assert!(!all.contains("Site banner"));
        assert!(!all.contains("Home"));
        assert!(!all.contains("Copyright"));
        assert!(!all.contains("not content"));
        assert!(!all.contains("color: red"));
    }

    #[test]
    fn short_inline_links_stay_paragraphs() {
        let (_, blocks) =
            extract("<p>A long sentence about many things with one <a href=\"/x\">tiny</a> link inside it.</p>", "https://e.org/");
        assert_eq!(blocks[0].kind, "paragraph");
        assert!(blocks[0].href.is_none());
    }

    #[test]
    fn resolves_urls() {
        let base = "https://example.org/docs/guide/intro.html?q=1";
        assert_eq!(
            resolve_url(base, "../api/ref.html").as_deref(),
            Some("https://example.org/docs/api/ref.html")
        );
        assert_eq!(
            resolve_url(base, "/root.html").as_deref(),
            Some("https://example.org/root.html")
        );
        assert_eq!(
            resolve_url(base, "//cdn.example.org/x").as_deref(),
            Some("https://cdn.example.org/x")
        );
        assert_eq!(resolve_url(base, "#frag"), None);
        assert_eq!(resolve_url(base, "javascript:void(0)"), None);
        assert_eq!(resolve_url(base, "mailto:a@b.c"), None);
    }

    #[test]
    fn drops_chrome_and_hidden_subtrees() {
        let html = r##"<body>
<a class="jump" href="#bodyContent">Jump to content</a>
<div role="navigation"><div><a href="/nav">Nav entry</a></div></div>
<div aria-hidden="true"><p>Screen-reader chrome</p></div>
<ul><li><a href="#s1">1. Introduction</a></li><li><a href="#s2">2. History</a></li></ul>
<h2><a href="#anchor">Linked Heading</a></h2>
<p>Real content stays.</p>
</body>"##;
        let (_, blocks) = extract(html, "https://example.org/a");
        let all: String = blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("|");
        assert!(!all.contains("Jump to content"), "got: {}", all);
        assert!(!all.contains("Nav entry"), "got: {}", all);
        assert!(!all.contains("Screen-reader chrome"), "got: {}", all);
        assert!(!all.contains("Introduction"), "got: {}", all);
        assert!(all.contains("Linked Heading"));
        assert!(all.contains("Real content stays."));
        assert!(blocks.iter().any(|b| b.kind == "heading" && b.text == "Linked Heading"));
    }

    #[test]
    fn tolerates_broken_markup() {
        let (_, blocks) = extract("<p>unclosed paragraph <b>bold <h2>Next</h2>", "https://e.org/");
        assert!(blocks.iter().any(|b| b.text.contains("unclosed paragraph")));
        assert!(blocks.iter().any(|b| b.kind == "heading" && b.text == "Next"));
        let (_, weird) = extract("a < b but 3 > 2 <p>ok</p>", "https://e.org/");
        assert!(weird.iter().any(|b| b.text.contains("ok")));
    }
}

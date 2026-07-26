/**
 * Allowlist HTML sanitizer for the html viewer element. Content bound to
 * the element is data from operations (mail bodies, converted markdown),
 * so everything executable or interactive is removed: only formatting
 * tags survive, links keep their text but lose navigation, and images
 * allow only data: and https: sources.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
  'blockquote',
  'code',
  'pre',
]);

/** Attributes kept per tag; everything else is dropped. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  img: new Set(['src', 'alt']),
  a: new Set(['title']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
};

function sanitizeNode(node: Node, doc: Document, into: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrappers unwrap so their text survives; executable and
      // embedded content disappears whole.
      if (!['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math'].includes(tag)) {
        sanitizeNode(element, doc, into);
      }
      continue;
    }
    const clean = doc.createElement(tag);
    const allowed = ALLOWED_ATTRS[tag];
    if (allowed) {
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name)) continue;
        if (tag === 'img' && name === 'src') {
          const value = attr.value.trim();
          if (!/^(data:image\/|https:)/i.test(value)) continue;
        }
        clean.setAttribute(name, attr.value);
      }
    }
    // Links stay readable but never navigate; the destination rides the
    // tooltip so the reader can judge it.
    if (tag === 'a') {
      const href = element.getAttribute('href') ?? '';
      if (href && !clean.getAttribute('title')) {
        clean.setAttribute('title', href);
      }
    }
    sanitizeNode(element, doc, clean);
    into.appendChild(clean);
  }
}

export function sanitizeHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = doc.createElement('div');
  sanitizeNode(doc.body, doc, out);
  return out.innerHTML;
}

import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../sanitize-html';

describe('sanitizeHtml', () => {
  it('keeps formatting and drops everything executable', () => {
    const dirty =
      '<h1>Hi</h1><script>alert(1)</script><p onclick="x()">Body <b>bold</b></p>' +
      '<iframe src="https://evil.example"></iframe><style>p{display:none}</style>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain('<h1>Hi</h1>');
    expect(clean).toContain('<b>bold</b>');
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('iframe');
    expect(clean).not.toContain('style');
    expect(clean).not.toContain('onclick');
  });

  it('unwraps unknown tags so their text survives', () => {
    expect(sanitizeHtml('<article><p>kept</p></article>')).toBe('<p>kept</p>');
  });

  it('neutralizes links but keeps their text and destination tooltip', () => {
    const clean = sanitizeHtml('<a href="https://example.net/x">read this</a>');
    expect(clean).toContain('read this');
    expect(clean).not.toContain('href');
    expect(clean).toContain('title="https://example.net/x"');
  });

  it('allows only safe image sources', () => {
    expect(sanitizeHtml('<img src="https://example.net/a.png" alt="ok">')).toContain('src=');
    expect(sanitizeHtml('<img src="javascript:alert(1)">')).not.toContain('src=');
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toContain('src=');
    expect(sanitizeHtml('<img src="data:text/html;base64,AAAA">')).not.toContain('src=');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});

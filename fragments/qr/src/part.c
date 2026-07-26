/*
 * QR code part for the DER wasm host, guest ABI v1, written in C: the part
 * ABI is language-agnostic, and this module is the reference for non-Rust
 * publishers. Exports memory, der_alloc, and der_run; imports nothing.
 * qr.encode turns text into a PNG (uncompressed-deflate encoding, so no
 * zlib), answered as base64 in the JSON envelope.
 *
 * The QR encoding itself is Project Nayuki's qrcodegen (MIT), vendored
 * unmodified in ../vendor.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../vendor/qrcodegen.h"

/* ---- freestanding runtime: the little bits libc would provide ---------- */

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

void *memset(void *dst, int value, size_t n) {
  unsigned char *d = dst;
  for (size_t i = 0; i < n; i++) d[i] = (unsigned char)value;
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  if (d < s) {
    for (size_t i = 0; i < n; i++) d[i] = s[i];
  } else {
    for (size_t i = n; i > 0; i--) d[i - 1] = s[i - 1];
  }
  return dst;
}

size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  return n;
}

/* Bump allocator over linear memory; the host sends one request per fresh
 * instance, so nothing ever frees. */
extern unsigned char __heap_base;
static size_t heap_next = 0;

__attribute__((export_name("der_alloc"))) int32_t der_alloc(int32_t size) {
  if (size <= 0) return 0;
  size_t base = (size_t)&__heap_base;
  if (heap_next < base) heap_next = base;
  size_t aligned = (heap_next + 7u) & ~7u;
  size_t end = aligned + (size_t)size;
  size_t have = (size_t)__builtin_wasm_memory_size(0) * 65536u;
  while (end > have) {
    if (__builtin_wasm_memory_grow(0, ((end - have) / 65536u) + 1) == (size_t)-1) return 0;
    have = (size_t)__builtin_wasm_memory_size(0) * 65536u;
  }
  heap_next = end;
  return (int32_t)aligned;
}

static unsigned char *bump(size_t size) {
  int32_t at = der_alloc((int32_t)size);
  return at == 0 ? 0 : (unsigned char *)(size_t)at;
}

/* ---- minimal JSON reading: exactly the envelope shape ------------------ */

/* Finds "key": in an object region and returns a pointer just past the
 * colon, or 0. Shallow scan; good for the flat inputs object. */
static const char *find_key(const char *json, size_t len, const char *key) {
  size_t klen = strlen(key);
  for (size_t i = 0; i + klen + 3 < len; i++) {
    if (json[i] != '"') continue;
    if (i + 1 + klen >= len) break;
    bool match = true;
    for (size_t j = 0; j < klen; j++) {
      if (json[i + 1 + j] != key[j]) { match = false; break; }
    }
    if (!match || json[i + 1 + klen] != '"') continue;
    size_t at = i + 2 + klen;
    while (at < len && (json[at] == ' ' || json[at] == '\t' || json[at] == '\n')) at++;
    if (at < len && json[at] == ':') return json + at + 1;
  }
  return 0;
}

/* Decodes the JSON string starting at the first quote after `from`; writes
 * UTF-8 into out (cap bytes), returns length or -1. */
static int read_string(const char *from, const char *end, char *out, size_t cap) {
  while (from < end && *from != '"') {
    if (*from != ' ' && *from != '\t' && *from != '\n' && *from != '\r') return -1;
    from++;
  }
  if (from >= end) return -1;
  from++;
  size_t n = 0;
  while (from < end) {
    char c = *from++;
    if (c == '"') return (int)n;
    if (c == '\\') {
      if (from >= end) return -1;
      char esc = *from++;
      unsigned int code = 0;
      switch (esc) {
        case 'n': c = '\n'; break;
        case 't': c = '\t'; break;
        case 'r': c = '\r'; break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case '"': c = '"'; break;
        case '\\': c = '\\'; break;
        case '/': c = '/'; break;
        case 'u':
          if (end - from < 4) return -1;
          for (int i = 0; i < 4; i++) {
            char h = from[i];
            code <<= 4;
            if (h >= '0' && h <= '9') code |= (unsigned)(h - '0');
            else if (h >= 'a' && h <= 'f') code |= (unsigned)(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code |= (unsigned)(h - 'A' + 10);
            else return -1;
          }
          from += 4;
          if (code < 0x80) {
            c = (char)code;
          } else if (code < 0x800) {
            if (n + 2 > cap) return -1;
            out[n++] = (char)(0xC0 | (code >> 6));
            out[n++] = (char)(0x80 | (code & 0x3F));
            continue;
          } else {
            if (n + 3 > cap) return -1;
            out[n++] = (char)(0xE0 | (code >> 12));
            out[n++] = (char)(0x80 | ((code >> 6) & 0x3F));
            out[n++] = (char)(0x80 | (code & 0x3F));
            continue;
          }
          break;
        default: return -1;
      }
    }
    if (n + 1 > cap) return -1;
    out[n++] = c;
  }
  return -1;
}

static long read_number(const char *from, const char *end, long fallback) {
  while (from < end && (*from == ' ' || *from == '\t' || *from == '\n')) from++;
  bool any = false;
  long value = 0;
  while (from < end && *from >= '0' && *from <= '9') {
    value = value * 10 + (*from - '0');
    from++;
    any = true;
  }
  return any ? value : fallback;
}

/* ---- PNG writer: grayscale, stored deflate blocks, no zlib ------------- */

static const uint32_t CRC_POLY = 0xEDB88320u;

static uint32_t crc32_of(const unsigned char *data, size_t len, uint32_t seed) {
  uint32_t crc = seed ^ 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc >> 1) ^ (CRC_POLY & (~(crc & 1u) + 1u));
  }
  return crc ^ 0xFFFFFFFFu;
}

static void put_u32(unsigned char *at, uint32_t value) {
  at[0] = (unsigned char)(value >> 24);
  at[1] = (unsigned char)(value >> 16);
  at[2] = (unsigned char)(value >> 8);
  at[3] = (unsigned char)value;
}

static size_t write_chunk(unsigned char *out, const char type[4],
                          const unsigned char *payload, size_t len) {
  put_u32(out, (uint32_t)len);
  memcpy(out + 4, type, 4);
  if (len) memcpy(out + 8, payload, len);
  uint32_t crc = crc32_of(out + 4, len + 4, 0);
  put_u32(out + 8 + len, crc);
  return 12 + len;
}

/* Encodes width x height 8-bit grayscale rows (no filter) as a PNG. */
static unsigned char *encode_png(const unsigned char *pixels, uint32_t width,
                                 uint32_t height, size_t *png_len) {
  size_t row = (size_t)width + 1;
  size_t raw_len = row * height;
  unsigned char *raw = bump(raw_len);
  if (!raw) return 0;
  for (uint32_t y = 0; y < height; y++) {
    raw[y * row] = 0; /* filter: none */
    memcpy(raw + y * row + 1, pixels + (size_t)y * width, width);
  }

  /* zlib stream with stored blocks. */
  size_t blocks = (raw_len + 65534) / 65535;
  size_t zlen = 2 + blocks * 5 + raw_len + 4;
  unsigned char *z = bump(zlen);
  if (!z) return 0;
  size_t zi = 0;
  z[zi++] = 0x78;
  z[zi++] = 0x01;
  uint32_t a = 1, b = 0;
  for (size_t i = 0; i < raw_len; i++) {
    a = (a + raw[i]) % 65521u;
    b = (b + a) % 65521u;
  }
  size_t left = raw_len;
  size_t at = 0;
  while (left > 0 || blocks == 0) {
    size_t take = left > 65535 ? 65535 : left;
    z[zi++] = (left - take) == 0 ? 1 : 0; /* BFINAL on the last block */
    z[zi++] = (unsigned char)(take & 0xFF);
    z[zi++] = (unsigned char)(take >> 8);
    z[zi++] = (unsigned char)(~take & 0xFF);
    z[zi++] = (unsigned char)((~take >> 8) & 0xFF);
    memcpy(z + zi, raw + at, take);
    zi += take;
    at += take;
    left -= take;
    if (left == 0) break;
  }
  put_u32(z + zi, (b << 16) | a);
  zi += 4;

  unsigned char ihdr[13];
  put_u32(ihdr, width);
  put_u32(ihdr + 4, height);
  ihdr[8] = 8;  /* bit depth */
  ihdr[9] = 0;  /* grayscale */
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  size_t total = 8 + 12 + 13 + 12 + zi + 12;
  unsigned char *png = bump(total);
  if (!png) return 0;
  static const unsigned char sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  memcpy(png, sig, 8);
  size_t o = 8;
  o += write_chunk(png + o, "IHDR", ihdr, 13);
  o += write_chunk(png + o, "IDAT", z, zi);
  o += write_chunk(png + o, "IEND", 0, 0);
  *png_len = o;
  return png;
}

/* ---- base64 and the response envelope ---------------------------------- */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *base64_encode(const unsigned char *data, size_t len, size_t *out_len) {
  size_t n = ((len + 2) / 3) * 4;
  char *out = (char *)bump(n + 1);
  if (!out) return 0;
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)data[i] << 16;
    if (i + 1 < len) v |= (uint32_t)data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < len ? B64[v & 63] : '=';
  }
  out[o] = 0;
  *out_len = o;
  return out;
}

static size_t append(char *out, size_t at, const char *text) {
  size_t n = strlen(text);
  memcpy(out + at, text, n);
  return at + n;
}

static size_t append_uint(char *out, size_t at, uint32_t value) {
  char digits[12];
  int n = 0;
  if (value == 0) digits[n++] = '0';
  while (value > 0) {
    digits[n++] = (char)('0' + value % 10);
    value /= 10;
  }
  while (n > 0) out[at++] = digits[--n];
  return at;
}

static int64_t pack(const char *json, size_t len) {
  return ((int64_t)(int32_t)(size_t)json << 32) | (int64_t)len;
}

static int64_t err_response(const char *message) {
  char *out = (char *)bump(strlen(message) + 24);
  if (!out) return 0;
  size_t at = 0;
  at = append(out, at, "{\"err\":\"");
  at = append(out, at, message);
  at = append(out, at, "\"}");
  return pack(out, at);
}

/* ---- the operation ------------------------------------------------------ */

__attribute__((export_name("der_run"))) int64_t der_run(int32_t ptr, int32_t len) {
  if (ptr <= 0 || len <= 0) return err_response("empty request");
  const char *json = (const char *)(size_t)ptr;
  const char *end = json + len;

  const char *op_at = find_key(json, (size_t)len, "operation");
  if (!op_at) return err_response("request has no operation name");
  char op[64];
  int op_len = read_string(op_at, end, op, sizeof(op) - 1);
  if (op_len < 0) return err_response("request has no operation name");
  op[op_len] = 0;
  bool is_encode = true;
  const char *want = "qr.encode";
  for (int i = 0; want[i] || op[i]; i++) {
    if (op[i] != want[i]) { is_encode = false; break; }
  }
  if (!is_encode) return err_response("unknown operation");

  const char *text_at = find_key(json, (size_t)len, "text");
  if (!text_at) return err_response("text must be a non-empty string");
  char *text = (char *)bump(4096);
  if (!text) return err_response("out of memory");
  int text_len = read_string(text_at, end, text, 4095);
  if (text_len <= 0) return err_response("text must be a non-empty string");
  text[text_len] = 0;

  const char *scale_at = find_key(json, (size_t)len, "scale");
  long scale = scale_at ? read_number(scale_at, end, 8) : 8;
  if (scale < 1) scale = 1;
  if (scale > 32) scale = 32;
  const char *border_at = find_key(json, (size_t)len, "border");
  long border = border_at ? read_number(border_at, end, 4) : 4;
  if (border < 0) border = 0;
  if (border > 16) border = 16;

  uint8_t qrcode[qrcodegen_BUFFER_LEN_MAX];
  uint8_t temp[qrcodegen_BUFFER_LEN_MAX];
  if (!qrcodegen_encodeText(text, temp, qrcode, qrcodegen_Ecc_MEDIUM,
                            qrcodegen_VERSION_MIN, qrcodegen_VERSION_MAX,
                            qrcodegen_Mask_AUTO, true)) {
    return err_response("the text is too long for a QR code");
  }

  int modules = qrcodegen_getSize(qrcode);
  uint32_t side = (uint32_t)(modules + 2 * border) * (uint32_t)scale;
  if (side > 4096) return err_response("scale and border make the image too large");
  unsigned char *pixels = bump((size_t)side * side);
  if (!pixels) return err_response("out of memory");
  memset(pixels, 0xFF, (size_t)side * side);
  for (int y = 0; y < modules; y++) {
    for (int x = 0; x < modules; x++) {
      if (!qrcodegen_getModule(qrcode, x, y)) continue;
      uint32_t px = (uint32_t)(x + border) * (uint32_t)scale;
      uint32_t py = (uint32_t)(y + border) * (uint32_t)scale;
      for (long dy = 0; dy < scale; dy++) {
        unsigned char *row_at = pixels + ((size_t)py + (size_t)dy) * side + px;
        memset(row_at, 0x00, (size_t)scale);
      }
    }
  }

  size_t png_len = 0;
  unsigned char *png = encode_png(pixels, side, side, &png_len);
  if (!png) return err_response("out of memory");
  size_t b64_len = 0;
  char *b64 = base64_encode(png, png_len, &b64_len);
  if (!b64) return err_response("out of memory");

  char *out = (char *)bump(b64_len + 96);
  if (!out) return err_response("out of memory");
  size_t at = 0;
  at = append(out, at, "{\"ok\":{\"base64\":\"");
  memcpy(out + at, b64, b64_len);
  at += b64_len;
  at = append(out, at, "\",\"size\":");
  at = append_uint(out, at, side);
  at = append(out, at, ",\"modules\":");
  at = append_uint(out, at, (uint32_t)modules);
  at = append(out, at, "}}");
  return pack(out, at);
}

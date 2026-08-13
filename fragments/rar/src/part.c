/*
 * RAR extraction part for the DER wasm host, ABI v1 over wasip1, built on
 * libarchive's independent BSD-licensed RAR and RAR5 readers. Extraction
 * only: the RAR compressor is closed source and the unrar license forbids
 * re-creating it, so archives open and entries come out, and nothing here
 * writes the format.
 *
 * The host stages the granted archive under /in and harvests file-typed
 * outputs from /out as fresh grants; paths never appear in contracts.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include <archive.h>
#include <archive_entry.h>

#define MAX_ENTRY_BYTES (64 * 1024 * 1024)

/* ------------------------------------------------------------------ */
/* JSON out: growing buffer with escaping                              */
/* ------------------------------------------------------------------ */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static void buf_put(Buf *b, const char *text, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->len + n + 1) cap *= 2;
        b->data = realloc(b->data, cap);
        b->cap = cap;
    }
    memcpy(b->data + b->len, text, n);
    b->len += n;
    b->data[b->len] = 0;
}

static void buf_s(Buf *b, const char *text) { buf_put(b, text, strlen(text)); }

static void buf_json_str(Buf *b, const char *text) {
    buf_s(b, "\"");
    for (const char *p = text; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '"' || c == '\\') {
            char esc[3] = {'\\', (char)c, 0};
            buf_s(b, esc);
        } else if (c < 0x20) {
            char esc[8];
            snprintf(esc, sizeof esc, "\\u%04x", c);
            buf_s(b, esc);
        } else {
            buf_put(b, (const char *)&c, 1);
        }
    }
    buf_s(b, "\"");
}

static void buf_u64(Buf *b, uint64_t v) {
    char tmp[32];
    snprintf(tmp, sizeof tmp, "%llu", (unsigned long long)v);
    buf_s(b, tmp);
}

/* ------------------------------------------------------------------ */
/* JSON in: flat string lookups                                        */
/* ------------------------------------------------------------------ */

static const char *find_key(const char *json, const char *key) {
    char pattern[128];
    snprintf(pattern, sizeof pattern, "\"%s\"", key);
    const char *p = json;
    while ((p = strstr(p, pattern)) != NULL) {
        const char *after = p + strlen(pattern);
        while (*after == ' ' || *after == '\t' || *after == '\n' || *after == '\r') after++;
        if (*after == ':') {
            after++;
            while (*after == ' ' || *after == '\t' || *after == '\n' || *after == '\r') after++;
            return after;
        }
        p = after;
    }
    return NULL;
}

static int json_str(const char *json, const char *key, char *out, size_t cap) {
    const char *v = find_key(json, key);
    if (!v || *v != '"') return 0;
    v++;
    size_t n = 0;
    while (*v && *v != '"' && n + 1 < cap) {
        if (*v == '\\' && v[1]) {
            v++;
            char c = *v;
            if (c == 'n') c = '\n';
            else if (c == 't') c = '\t';
            out[n++] = c;
            v++;
        } else {
            out[n++] = *v++;
        }
    }
    out[n] = 0;
    return *v == '"';
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

static int64_t pack_response(Buf *b) {
    return ((int64_t)(uint32_t)(uintptr_t)b->data << 32) | (uint32_t)b->len;
}

static int64_t err_msg(const char *message) {
    Buf b = {0};
    buf_s(&b, "{\"err\":");
    buf_json_str(&b, message);
    buf_s(&b, "}");
    return pack_response(&b);
}

__attribute__((export_name("der_alloc"))) int32_t der_alloc(int32_t size) {
    if (size <= 0) return 0;
    return (int32_t)(uintptr_t)malloc((size_t)size);
}

/* ------------------------------------------------------------------ */
/* Archive plumbing                                                    */
/* ------------------------------------------------------------------ */

static struct archive *open_rar(const char *path, const char **error) {
    struct archive *a = archive_read_new();
    archive_read_support_format_rar(a);
    archive_read_support_format_rar5(a);
    if (archive_read_open_filename(a, path, 65536) != ARCHIVE_OK) {
        *error = archive_error_string(a);
        if (!*error) *error = "the file is not a readable RAR archive";
        return a; /* caller frees */
    }
    *error = NULL;
    return a;
}

static int64_t op_list(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run file.pick first");

    const char *error = NULL;
    struct archive *a = open_rar(path, &error);
    if (error) {
        int64_t reply = err_msg(error);
        archive_read_free(a);
        return reply;
    }

    Buf b = {0};
    buf_s(&b, "{\"ok\":{\"entries\":[");
    struct archive_entry *entry;
    int wrote = 0;
    uint64_t total = 0;
    while (archive_read_next_header(a, &entry) == ARCHIVE_OK) {
        const char *name = archive_entry_pathname_utf8(entry);
        if (!name) name = archive_entry_pathname(entry);
        if (!name) name = "";
        int is_dir = archive_entry_filetype(entry) == AE_IFDIR;
        uint64_t size = (uint64_t)archive_entry_size(entry);
        if (wrote++) buf_s(&b, ",");
        buf_s(&b, "{\"name\":");
        buf_json_str(&b, name);
        buf_s(&b, ",\"size\":");
        buf_u64(&b, size);
        buf_s(&b, ",\"kind\":");
        buf_json_str(&b, is_dir ? "folder" : "file");
        buf_s(&b, "}");
        if (!is_dir) total += size;
        archive_read_data_skip(a);
    }
    buf_s(&b, "],\"count\":");
    buf_u64(&b, (uint64_t)wrote);
    buf_s(&b, ",\"totalSize\":");
    buf_u64(&b, total);
    buf_s(&b, "}}");
    archive_read_free(a);
    return pack_response(&b);
}

static int64_t op_extract(const char *inputs) {
    char path[512];
    char wanted[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run file.pick first");
    if (!json_str(inputs, "name", wanted, sizeof wanted) || !wanted[0])
        return err_msg("name must be the entry to extract (see rar.list)");

    const char *error = NULL;
    struct archive *a = open_rar(path, &error);
    if (error) {
        int64_t reply = err_msg(error);
        archive_read_free(a);
        return reply;
    }

    struct archive_entry *entry;
    while (archive_read_next_header(a, &entry) == ARCHIVE_OK) {
        const char *name = archive_entry_pathname_utf8(entry);
        if (!name) name = archive_entry_pathname(entry);
        if (!name || strcmp(name, wanted) != 0) {
            archive_read_data_skip(a);
            continue;
        }
        if (archive_entry_is_encrypted(entry)) {
            archive_read_free(a);
            return err_msg("the entry is password protected; encrypted archives are not supported");
        }
        if (archive_entry_filetype(entry) == AE_IFDIR) {
            archive_read_free(a);
            return err_msg("that entry is a folder; extract one of its files instead");
        }
        int64_t declared = archive_entry_size(entry);
        if (declared > MAX_ENTRY_BYTES) {
            archive_read_free(a);
            return err_msg("the entry is larger than 64 MB");
        }

        /* Flatten the path: /out is flat, entry dirs collapse. */
        const char *flat = strrchr(name, '/');
        flat = flat ? flat + 1 : name;
        if (!*flat) flat = "entry";
        char out_path[600];
        snprintf(out_path, sizeof out_path, "/out/%s", flat);
        FILE *out = fopen(out_path, "wb");
        if (!out) {
            archive_read_free(a);
            return err_msg("could not write the extracted file");
        }
        char buffer[65536];
        int64_t written = 0;
        for (;;) {
            ssize_t got = archive_read_data(a, buffer, sizeof buffer);
            if (got == 0) break;
            if (got < 0) {
                const char *why = archive_error_string(a);
                fclose(out);
                archive_read_free(a);
                return err_msg(why ? why : "the entry does not decompress");
            }
            if (written + got > MAX_ENTRY_BYTES) {
                fclose(out);
                archive_read_free(a);
                return err_msg("the entry is larger than 64 MB");
            }
            fwrite(buffer, 1, (size_t)got, out);
            written += got;
        }
        fclose(out);
        archive_read_free(a);

        Buf b = {0};
        buf_s(&b, "{\"ok\":{\"file\":");
        buf_json_str(&b, out_path);
        buf_s(&b, ",\"name\":");
        buf_json_str(&b, flat);
        buf_s(&b, ",\"size\":");
        buf_u64(&b, (uint64_t)written);
        buf_s(&b, "}}");
        return pack_response(&b);
    }
    archive_read_free(a);
    Buf b = {0};
    buf_s(&b, "{\"err\":");
    char message[600];
    snprintf(message, sizeof message, "the archive has no entry \"%s\" (see rar.list)", wanted);
    buf_json_str(&b, message);
    buf_s(&b, "}");
    return pack_response(&b);
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

__attribute__((export_name("der_run"))) int64_t der_run(int32_t ptr, int32_t len) {
    if (ptr == 0 || len <= 0) return err_msg("empty request");
    char *request = malloc((size_t)len + 1);
    memcpy(request, (void *)(uintptr_t)(uint32_t)ptr, (size_t)len);
    request[len] = 0;

    char operation[64] = {0};
    json_str(request, "operation", operation, sizeof operation);
    const char *inputs = find_key(request, "inputs");
    if (!inputs) inputs = "{}";

    int64_t reply;
    if (strcmp(operation, "rar.list") == 0) reply = op_list(inputs);
    else if (strcmp(operation, "rar.extract") == 0) reply = op_extract(inputs);
    else reply = err_msg("unknown operation");

    free(request);
    return reply;
}

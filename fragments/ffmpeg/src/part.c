/*
 * Media part for the DER wasm host, ABI v1 over wasip1, FFmpeg inside.
 *
 * Exports memory, der_alloc, der_run. The host stages granted files under
 * /in, gives the part an empty /out, and harvests file-typed outputs as
 * fresh grants. media.toWav runs as a job: the host keeps this instance
 * alive between steps, so the decode state lives in statics here.
 *
 * All input/output paths arrive as guest paths chosen by the host; this
 * code never invents paths outside /out and never sees the real disk.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

/* ------------------------------------------------------------------ */
/* Growing output buffer with JSON escaping                            */
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

static void buf_f(Buf *b, const char *fmt, double v) {
    char tmp[64];
    snprintf(tmp, sizeof tmp, fmt, v);
    buf_s(b, tmp);
}

/* ------------------------------------------------------------------ */
/* Minimal JSON reading: flat {"key": "string" | number} lookups       */
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
            else if (c == 'r') c = '\r';
            out[n++] = c;
            v++;
        } else {
            out[n++] = *v++;
        }
    }
    out[n] = 0;
    return *v == '"';
}

static int json_num(const char *json, const char *key, double *out) {
    const char *v = find_key(json, key);
    if (!v) return 0;
    char *end = NULL;
    double parsed = strtod(v, &end);
    if (end == v) return 0;
    *out = parsed;
    return 1;
}

/* ------------------------------------------------------------------ */
/* Envelope plumbing                                                   */
/* ------------------------------------------------------------------ */

static int64_t pack_response(Buf *b) {
    /* The buffer is intentionally leaked; the host copies it out. */
    return ((int64_t)(uint32_t)(uintptr_t)b->data << 32) | (uint32_t)b->len;
}

static int64_t err_msg(const char *message) {
    Buf b = {0};
    buf_s(&b, "{\"err\":");
    buf_json_str(&b, message);
    buf_s(&b, "}");
    return pack_response(&b);
}

static int64_t err_av(const char *what, int code) {
    char averr[128] = {0};
    av_strerror(code, averr, sizeof averr);
    char full[256];
    snprintf(full, sizeof full, "%s: %s", what, averr);
    return err_msg(full);
}

__attribute__((export_name("der_alloc"))) int32_t der_alloc(int32_t size) {
    if (size <= 0) return 0;
    return (int32_t)(uintptr_t)malloc((size_t)size);
}

/* ------------------------------------------------------------------ */
/* media.probe                                                         */
/* ------------------------------------------------------------------ */

static int64_t op_probe(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run the operation that sets it first");

    AVFormatContext *fmt = NULL;
    int rc = avformat_open_input(&fmt, path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    rc = avformat_find_stream_info(fmt, NULL);
    if (rc < 0) {
        avformat_close_input(&fmt);
        return err_av("could not read the streams", rc);
    }

    double duration = fmt->duration > 0 ? (double)fmt->duration / AV_TIME_BASE : 0;
    Buf b = {0};
    buf_s(&b, "{\"ok\":{\"format\":");
    buf_json_str(&b, fmt->iformat ? fmt->iformat->name : "unknown");
    buf_s(&b, ",\"durationSeconds\":");
    buf_f(&b, "%.3f", duration);
    buf_s(&b, ",\"streams\":[");
    int wrote = 0;
    for (unsigned i = 0; i < fmt->nb_streams; i++) {
        AVCodecParameters *par = fmt->streams[i]->codecpar;
        const char *kind = par->codec_type == AVMEDIA_TYPE_VIDEO   ? "video"
                           : par->codec_type == AVMEDIA_TYPE_AUDIO ? "audio"
                                                                   : "other";
        if (strcmp(kind, "other") == 0) continue;
        if (wrote++) buf_s(&b, ",");
        buf_s(&b, "{\"kind\":");
        buf_json_str(&b, kind);
        buf_s(&b, ",\"codec\":");
        buf_json_str(&b, avcodec_get_name(par->codec_id));
        buf_s(&b, ",\"width\":");
        buf_f(&b, "%.0f", (double)par->width);
        buf_s(&b, ",\"height\":");
        buf_f(&b, "%.0f", (double)par->height);
        buf_s(&b, ",\"sampleRate\":");
        buf_f(&b, "%.0f", (double)par->sample_rate);
        buf_s(&b, ",\"channels\":");
        buf_f(&b, "%.0f", (double)par->ch_layout.nb_channels);
        buf_s(&b, "}");
    }
    buf_s(&b, "],\"streamCount\":");
    buf_f(&b, "%.0f", (double)wrote);
    buf_s(&b, "}}");
    avformat_close_input(&fmt);
    return pack_response(&b);
}

/* ------------------------------------------------------------------ */
/* Shared: open input and one decoder                                  */
/* ------------------------------------------------------------------ */

static int open_decoder(AVFormatContext *fmt, enum AVMediaType type, int *stream_index,
                        AVCodecContext **dec_out) {
    int idx = av_find_best_stream(fmt, type, -1, -1, NULL, 0);
    if (idx < 0) return idx;
    AVStream *stream = fmt->streams[idx];
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) return AVERROR_DECODER_NOT_FOUND;
    AVCodecContext *dec = avcodec_alloc_context3(codec);
    if (!dec) return AVERROR(ENOMEM);
    int rc = avcodec_parameters_to_context(dec, stream->codecpar);
    if (rc < 0) {
        avcodec_free_context(&dec);
        return rc;
    }
    rc = avcodec_open2(dec, codec, NULL);
    if (rc < 0) {
        avcodec_free_context(&dec);
        return rc;
    }
    *stream_index = idx;
    *dec_out = dec;
    return 0;
}

/* ------------------------------------------------------------------ */
/* media.thumbnail                                                     */
/* ------------------------------------------------------------------ */

static int64_t op_thumbnail(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run the operation that sets it first");
    double at = 0;
    json_num(inputs, "atSeconds", &at);
    if (at < 0) at = 0;

    AVFormatContext *fmt = NULL;
    int rc = avformat_open_input(&fmt, path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    if ((rc = avformat_find_stream_info(fmt, NULL)) < 0) {
        avformat_close_input(&fmt);
        return err_av("could not read the streams", rc);
    }
    int vidx = -1;
    AVCodecContext *dec = NULL;
    if ((rc = open_decoder(fmt, AVMEDIA_TYPE_VIDEO, &vidx, &dec)) < 0) {
        avformat_close_input(&fmt);
        return err_av("no decodable video stream", rc);
    }
    AVStream *vstream = fmt->streams[vidx];
    int64_t target = av_rescale_q((int64_t)(at * AV_TIME_BASE), AV_TIME_BASE_Q,
                                  vstream->time_base);
    if (at > 0) av_seek_frame(fmt, vidx, target, AVSEEK_FLAG_BACKWARD);

    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    AVFrame *chosen = NULL;
    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index != vidx) {
            av_packet_unref(pkt);
            continue;
        }
        rc = avcodec_send_packet(dec, pkt);
        av_packet_unref(pkt);
        if (rc < 0) break;
        while ((rc = avcodec_receive_frame(dec, frame)) >= 0) {
            int64_t pts = frame->best_effort_timestamp;
            if (pts == AV_NOPTS_VALUE) pts = 0;
            if (pts >= target || at == 0) {
                chosen = frame;
                break;
            }
        }
        if (chosen) break;
    }
    if (!chosen) {
        /* Drain: the last decoded frame near EOF still serves. */
        avcodec_send_packet(dec, NULL);
        if (avcodec_receive_frame(dec, frame) >= 0) chosen = frame;
    }
    if (!chosen) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        avcodec_free_context(&dec);
        avformat_close_input(&fmt);
        return err_msg("no video frame at that time; try a smaller atSeconds");
    }

    /* JPEG wants full-range 4:2:0; scale/convert whatever arrived. */
    const AVCodec *jpeg = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    AVCodecContext *enc = avcodec_alloc_context3(jpeg);
    enc->width = chosen->width;
    enc->height = chosen->height;
    enc->pix_fmt = AV_PIX_FMT_YUVJ420P;
    enc->time_base = (AVRational){1, 25};
    enc->color_range = AVCOL_RANGE_JPEG;
    if ((rc = avcodec_open2(enc, jpeg, NULL)) < 0) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        avcodec_free_context(&dec);
        avcodec_free_context(&enc);
        avformat_close_input(&fmt);
        return err_av("could not open the JPEG encoder", rc);
    }
    struct SwsContext *sws = sws_getContext(chosen->width, chosen->height, chosen->format,
                                            enc->width, enc->height, enc->pix_fmt,
                                            SWS_BILINEAR, NULL, NULL, NULL);
    AVFrame *yuv = av_frame_alloc();
    yuv->format = enc->pix_fmt;
    yuv->width = enc->width;
    yuv->height = enc->height;
    av_frame_get_buffer(yuv, 32);
    sws_scale(sws, (const uint8_t *const *)chosen->data, chosen->linesize, 0,
              chosen->height, yuv->data, yuv->linesize);
    yuv->color_range = AVCOL_RANGE_JPEG;

    AVPacket *out_pkt = av_packet_alloc();
    rc = avcodec_send_frame(enc, yuv);
    if (rc >= 0) rc = avcodec_receive_packet(enc, out_pkt);
    int64_t reply;
    if (rc < 0) {
        reply = err_av("could not encode the thumbnail", rc);
    } else {
        FILE *out = fopen("/out/thumbnail.jpg", "wb");
        if (!out) {
            reply = err_msg("could not write /out/thumbnail.jpg");
        } else {
            fwrite(out_pkt->data, 1, out_pkt->size, out);
            fclose(out);
            Buf b = {0};
            buf_s(&b, "{\"ok\":{\"file\":\"/out/thumbnail.jpg\",\"width\":");
            buf_f(&b, "%.0f", (double)enc->width);
            buf_s(&b, ",\"height\":");
            buf_f(&b, "%.0f", (double)enc->height);
            buf_s(&b, "}}");
            reply = pack_response(&b);
        }
    }
    av_packet_free(&out_pkt);
    av_frame_free(&yuv);
    sws_freeContext(sws);
    av_frame_free(&frame);
    av_packet_free(&pkt);
    avcodec_free_context(&dec);
    avcodec_free_context(&enc);
    avformat_close_input(&fmt);
    return reply;
}

/* ------------------------------------------------------------------ */
/* Stream-copy remux core for audioExtract and trim                    */
/* ------------------------------------------------------------------ */

static int64_t remux(const char *in_path, const char *out_name, const char *muxer,
                     int only_stream, double from_s, double to_s, const char *codec_label) {
    AVFormatContext *in = NULL;
    int rc = avformat_open_input(&in, in_path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    if ((rc = avformat_find_stream_info(in, NULL)) < 0) {
        avformat_close_input(&in);
        return err_av("could not read the streams", rc);
    }

    AVFormatContext *out = NULL;
    rc = avformat_alloc_output_context2(&out, NULL, muxer, out_name);
    if (rc < 0 || !out) {
        avformat_close_input(&in);
        return err_av("could not open the output container", rc < 0 ? rc : AVERROR_UNKNOWN);
    }

    /* Map the copied streams; -1 copies every audio/video stream. */
    int map[64];
    for (unsigned i = 0; i < in->nb_streams && i < 64; i++) {
        map[i] = -1;
        AVCodecParameters *par = in->streams[i]->codecpar;
        int wanted = only_stream >= 0
                         ? (int)i == only_stream
                         : (par->codec_type == AVMEDIA_TYPE_VIDEO ||
                            par->codec_type == AVMEDIA_TYPE_AUDIO);
        if (!wanted) continue;
        AVStream *created = avformat_new_stream(out, NULL);
        avcodec_parameters_copy(created->codecpar, par);
        created->codecpar->codec_tag = 0;
        created->time_base = in->streams[i]->time_base;
        map[i] = created->index;
    }

    if ((rc = avio_open(&out->pb, out_name, AVIO_FLAG_WRITE)) < 0 ||
        (rc = avformat_write_header(out, NULL)) < 0) {
        avformat_close_input(&in);
        avformat_free_context(out);
        return err_av("could not start the output file", rc);
    }

    if (from_s > 0)
        av_seek_frame(in, -1, (int64_t)(from_s * AV_TIME_BASE), AVSEEK_FLAG_BACKWARD);

    AVPacket *pkt = av_packet_alloc();
    while (av_read_frame(in, pkt) >= 0) {
        unsigned i = pkt->stream_index;
        if (i >= 64 || map[i] < 0) {
            av_packet_unref(pkt);
            continue;
        }
        AVStream *src = in->streams[i];
        if (to_s > 0 && pkt->pts != AV_NOPTS_VALUE) {
            double at = pkt->pts * av_q2d(src->time_base);
            if (at > to_s) {
                av_packet_unref(pkt);
                break;
            }
        }
        AVStream *dst = out->streams[map[i]];
        av_packet_rescale_ts(pkt, src->time_base, dst->time_base);
        pkt->stream_index = dst->index;
        pkt->pos = -1;
        av_interleaved_write_frame(out, pkt);
        av_packet_unref(pkt);
    }
    av_packet_free(&pkt);
    av_write_trailer(out);
    avio_closep(&out->pb);
    avformat_free_context(out);
    avformat_close_input(&in);

    Buf b = {0};
    buf_s(&b, "{\"ok\":{\"file\":");
    buf_json_str(&b, out_name);
    buf_s(&b, ",\"codec\":");
    buf_json_str(&b, codec_label);
    buf_s(&b, "}}");
    return pack_response(&b);
}

static int64_t op_audio_extract(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run the operation that sets it first");

    AVFormatContext *probe = NULL;
    int rc = avformat_open_input(&probe, path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    if ((rc = avformat_find_stream_info(probe, NULL)) < 0) {
        avformat_close_input(&probe);
        return err_av("could not read the streams", rc);
    }
    int aidx = av_find_best_stream(probe, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (aidx < 0) {
        avformat_close_input(&probe);
        return err_msg("the media has no audio track");
    }
    enum AVCodecID codec = probe->streams[aidx]->codecpar->codec_id;
    avformat_close_input(&probe);

    const char *muxer = "matroska";
    const char *out_name = "/out/audio.mka";
    if (codec == AV_CODEC_ID_AAC) {
        muxer = "ipod";
        out_name = "/out/audio.m4a";
    } else if (codec == AV_CODEC_ID_MP3) {
        muxer = "mp3";
        out_name = "/out/audio.mp3";
    }
    return remux(path, out_name, muxer, aidx, 0, 0, avcodec_get_name(codec));
}

static int64_t op_trim(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run the operation that sets it first");
    double from_s = 0, to_s = 0;
    json_num(inputs, "fromSeconds", &from_s);
    json_num(inputs, "toSeconds", &to_s);
    if (to_s > 0 && to_s <= from_s)
        return err_msg("toSeconds must be after fromSeconds");

    AVFormatContext *probe = NULL;
    int rc = avformat_open_input(&probe, path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    const char *iname = probe->iformat ? probe->iformat->name : "";
    const char *muxer = "matroska";
    const char *out_name = "/out/trimmed.mkv";
    if (strstr(iname, "mp4") || strstr(iname, "mov")) {
        muxer = "mp4";
        out_name = "/out/trimmed.mp4";
    } else if (strstr(iname, "matroska")) {
        muxer = "matroska";
        out_name = "/out/trimmed.mkv";
    } else if (strstr(iname, "mp3")) {
        muxer = "mp3";
        out_name = "/out/trimmed.mp3";
    } else if (strstr(iname, "wav")) {
        muxer = "wav";
        out_name = "/out/trimmed.wav";
    }
    avformat_close_input(&probe);
    return remux(path, out_name, muxer, -1, from_s, to_s, muxer);
}

/* ------------------------------------------------------------------ */
/* media.toWav as a job: decode state persists across steps            */
/* ------------------------------------------------------------------ */

static struct {
    AVFormatContext *in;
    AVFormatContext *out;
    AVCodecContext *dec;
    AVCodecContext *enc;
    SwrContext *swr;
    AVPacket *pkt;
    AVFrame *frame;
    AVFrame *converted;
    int aidx;
    double duration;
    double reached;
    int64_t next_pts;
    int active;
} JOB;

static void job_close(void) {
    if (JOB.pkt) av_packet_free(&JOB.pkt);
    if (JOB.frame) av_frame_free(&JOB.frame);
    if (JOB.converted) av_frame_free(&JOB.converted);
    if (JOB.swr) swr_free(&JOB.swr);
    if (JOB.dec) avcodec_free_context(&JOB.dec);
    if (JOB.enc) avcodec_free_context(&JOB.enc);
    if (JOB.out) {
        if (JOB.out->pb) avio_closep(&JOB.out->pb);
        avformat_free_context(JOB.out);
        JOB.out = NULL;
    }
    if (JOB.in) avformat_close_input(&JOB.in);
    memset(&JOB, 0, sizeof JOB);
}

static int64_t op_towav_start(const char *inputs) {
    char path[512];
    if (!json_str(inputs, "file", path, sizeof path) || !path[0])
        return err_msg("file has no value yet; run the operation that sets it first");
    job_close();

    int rc = avformat_open_input(&JOB.in, path, NULL, NULL);
    if (rc < 0) return err_av("could not open the media", rc);
    if ((rc = avformat_find_stream_info(JOB.in, NULL)) < 0) {
        job_close();
        return err_av("could not read the streams", rc);
    }
    if ((rc = open_decoder(JOB.in, AVMEDIA_TYPE_AUDIO, &JOB.aidx, &JOB.dec)) < 0) {
        job_close();
        return err_av("no decodable audio stream", rc);
    }
    JOB.duration = JOB.in->duration > 0 ? (double)JOB.in->duration / AV_TIME_BASE : 0;

    const AVCodec *pcm = avcodec_find_encoder(AV_CODEC_ID_PCM_S16LE);
    JOB.enc = avcodec_alloc_context3(pcm);
    JOB.enc->sample_rate = JOB.dec->sample_rate;
    av_channel_layout_copy(&JOB.enc->ch_layout, &JOB.dec->ch_layout);
    JOB.enc->sample_fmt = AV_SAMPLE_FMT_S16;
    JOB.enc->time_base = (AVRational){1, JOB.enc->sample_rate};
    if ((rc = avcodec_open2(JOB.enc, pcm, NULL)) < 0) {
        job_close();
        return err_av("could not open the WAV encoder", rc);
    }
    if ((rc = avformat_alloc_output_context2(&JOB.out, NULL, "wav", "/out/audio.wav")) < 0) {
        job_close();
        return err_av("could not open the output container", rc);
    }
    AVStream *created = avformat_new_stream(JOB.out, NULL);
    avcodec_parameters_from_context(created->codecpar, JOB.enc);
    created->time_base = JOB.enc->time_base;
    if ((rc = avio_open(&JOB.out->pb, "/out/audio.wav", AVIO_FLAG_WRITE)) < 0 ||
        (rc = avformat_write_header(JOB.out, NULL)) < 0) {
        job_close();
        return err_av("could not start the output file", rc);
    }
    swr_alloc_set_opts2(&JOB.swr, &JOB.enc->ch_layout, AV_SAMPLE_FMT_S16,
                        JOB.enc->sample_rate, &JOB.dec->ch_layout, JOB.dec->sample_fmt,
                        JOB.dec->sample_rate, 0, NULL);
    if (!JOB.swr || swr_init(JOB.swr) < 0) {
        job_close();
        return err_msg("could not prepare the sample converter");
    }
    JOB.pkt = av_packet_alloc();
    JOB.frame = av_frame_alloc();
    JOB.converted = av_frame_alloc();
    JOB.active = 1;

    Buf b = {0};
    buf_s(&b, "{\"ok\":{\"durationSeconds\":");
    buf_f(&b, "%.3f", JOB.duration);
    buf_s(&b, "}}");
    return pack_response(&b);
}

static int write_converted(AVFrame *decoded) {
    JOB.converted->ch_layout = JOB.enc->ch_layout;
    JOB.converted->format = AV_SAMPLE_FMT_S16;
    JOB.converted->sample_rate = JOB.enc->sample_rate;
    int rc = swr_convert_frame(JOB.swr, JOB.converted, decoded);
    if (rc < 0) return rc;
    JOB.converted->pts = JOB.next_pts;
    JOB.next_pts += JOB.converted->nb_samples;
    rc = avcodec_send_frame(JOB.enc, JOB.converted);
    while (rc >= 0) {
        AVPacket *out_pkt = av_packet_alloc();
        rc = avcodec_receive_packet(JOB.enc, out_pkt);
        if (rc >= 0) {
            out_pkt->stream_index = 0;
            av_packet_rescale_ts(out_pkt, JOB.enc->time_base, JOB.out->streams[0]->time_base);
            av_interleaved_write_frame(JOB.out, out_pkt);
        }
        av_packet_free(&out_pkt);
    }
    av_frame_unref(JOB.converted);
    return rc == AVERROR(EAGAIN) || rc == AVERROR_EOF ? 0 : rc;
}

#define PACKETS_PER_STEP 600

static int64_t op_towav_step(void) {
    if (!JOB.active) return err_msg("no conversion is running in this instance");
    int processed = 0;
    int rc = 0;
    while (processed < PACKETS_PER_STEP) {
        rc = av_read_frame(JOB.in, JOB.pkt);
        if (rc < 0) break; /* EOF or error: finish below */
        if (JOB.pkt->stream_index != JOB.aidx) {
            av_packet_unref(JOB.pkt);
            continue;
        }
        processed++;
        if (JOB.pkt->pts != AV_NOPTS_VALUE)
            JOB.reached = JOB.pkt->pts * av_q2d(JOB.in->streams[JOB.aidx]->time_base);
        int send = avcodec_send_packet(JOB.dec, JOB.pkt);
        av_packet_unref(JOB.pkt);
        if (send < 0) continue; /* tolerate bad packets */
        while (avcodec_receive_frame(JOB.dec, JOB.frame) >= 0) {
            if (write_converted(JOB.frame) < 0) {
                job_close();
                return err_msg("sample conversion failed");
            }
        }
    }

    if (rc < 0) {
        /* Drain decoder and close the file: the job is done. */
        avcodec_send_packet(JOB.dec, NULL);
        while (avcodec_receive_frame(JOB.dec, JOB.frame) >= 0) write_converted(JOB.frame);
        av_write_trailer(JOB.out);
        avio_closep(&JOB.out->pb);
        double duration = JOB.duration;
        job_close();
        Buf b = {0};
        buf_s(&b, "{\"ok\":{\"progress\":1,\"done\":true,\"file\":\"/out/audio.wav\",\"durationSeconds\":");
        buf_f(&b, "%.3f", duration);
        buf_s(&b, "}}");
        return pack_response(&b);
    }

    double progress = JOB.duration > 0 ? JOB.reached / JOB.duration : 0;
    if (progress > 0.99) progress = 0.99;
    Buf b = {0};
    buf_s(&b, "{\"ok\":{\"progress\":");
    buf_f(&b, "%.3f", progress);
    buf_s(&b, ",\"done\":false}}");
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
    if (strcmp(operation, "media.probe") == 0) reply = op_probe(inputs);
    else if (strcmp(operation, "media.thumbnail") == 0) reply = op_thumbnail(inputs);
    else if (strcmp(operation, "media.audioExtract") == 0) reply = op_audio_extract(inputs);
    else if (strcmp(operation, "media.trim") == 0) reply = op_trim(inputs);
    else if (strcmp(operation, "media.toWav") == 0) reply = op_towav_start(inputs);
    else if (strcmp(operation, "media.toWavStep") == 0) reply = op_towav_step();
    else reply = err_msg("unknown operation");

    free(request);
    return reply;
}

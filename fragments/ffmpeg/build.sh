#!/bin/sh
# Builds the media part: FFmpeg (LGPL components only) compiled to
# wasm32-wasip1 with the brew llvm + wasi-libc + wasi-runtimes toolchain,
# wrapped by src/part.c into the DER part ABI.
#
# Needs: brew install llvm wasi-libc wasi-runtimes
set -e
cd "$(dirname "$0")"

FFMPEG_VERSION=7.1.1
FFMPEG_SHA256=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
SYSROOT="${WASI_SYSROOT:-$(brew --prefix wasi-libc)/share/wasi-sysroot}"
LLVM="${LLVM_BIN:-$(brew --prefix llvm)/bin}"

mkdir -p vendor
TARBALL="vendor/ffmpeg-$FFMPEG_VERSION.tar.xz"
if [ ! -f "$TARBALL" ]; then
  curl -sL -o "$TARBALL" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
fi
echo "$FFMPEG_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null
[ -d "vendor/ffmpeg-$FFMPEG_VERSION" ] || tar xf "$TARBALL" -C vendor

cd "vendor/ffmpeg-$FFMPEG_VERSION"
if [ ! -f config.h ]; then
  ./configure \
    --cc="$LLVM/clang" --ar="$LLVM/llvm-ar" --ranlib="$LLVM/llvm-ranlib" \
    --nm="$LLVM/llvm-nm" --strip="$LLVM/llvm-strip" \
    --target-os=none --arch=c --enable-cross-compile \
    --disable-asm --disable-inline-asm --disable-x86asm \
    --disable-pthreads --disable-network --disable-debug --disable-doc --disable-programs \
    --disable-avdevice --disable-postproc --disable-avfilter \
    --disable-everything \
    --enable-protocol=file \
    --enable-demuxer=mov,matroska,mp3,wav,flac,ogg \
    --enable-muxer=mp4,ipod,matroska,matroska_audio,wav,mp3,image2 \
    --enable-decoder=h264,hevc,vp8,vp9,mpeg4,aac,mp3,mp3float,pcm_s16le,pcm_s16be,flac,vorbis,opus \
    --enable-encoder=mjpeg,pcm_s16le \
    --enable-parser=h264,hevc,aac,mpegaudio,vp8,vp9,opus,vorbis,flac,mjpeg \
    --enable-swscale --enable-swresample \
    --disable-vulkan --disable-iconv --disable-zlib --disable-securetransport \
    --disable-audiotoolbox --disable-videotoolbox --disable-coreimage --disable-appkit --disable-avfoundation \
    --extra-cflags="--target=wasm32-wasip1 --sysroot=$SYSROOT -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -O2" \
    --extra-ldflags="--target=wasm32-wasip1 --sysroot=$SYSROOT -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman"
fi
make -j8

# The h264 decoder needs real stack; wasm has no guard pages, so size it up
# front and keep the stack below the heap.
"$LLVM/clang" --target=wasm32-wasip1 --sysroot="$SYSROOT" \
  -O2 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  -I. ../../src/part.c \
  libavformat/libavformat.a libavcodec/libavcodec.a \
  libswscale/libswscale.a libswresample/libswresample.a libavutil/libavutil.a \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  -mexec-model=reactor -Wl,--export=der_alloc -Wl,--export=der_run -Wl,--export-memory \
  -Wl,-z,stack-size=8388608 -Wl,--stack-first \
  -o ../../media.wasm
echo "wrote media.wasm ($(wc -c < ../../media.wasm | tr -d ' ') bytes)"

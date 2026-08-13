# Media part

FFmpeg compiled to wasm32-wasip1, wrapped in the DER part ABI as
`der-labs.media`. The operations name capabilities (`media.probe`,
`media.thumbnail`, `media.audioExtract`, `media.trim`, `media.toWav` as a
start/step job); FFmpeg is the driver behind them.

The build is LGPL-only: `configure --disable-everything` plus an explicit
component list, no GPL components (no x264/x265), no external libraries.
FFmpeg is LGPL 2.1+; this directory's `build.sh` pins the exact source
release (ffmpeg.org tarball, sha256-verified) and the full configuration,
which together satisfy the license's source and relink requirements for
the shipped bundle. The wasm module declares `wasi:files`, `wasi:clocks`,
and `io:large`; file inputs and outputs ride the grant sandbox, so the
module never sees a real path.

Rebuild with `./build.sh` (brew llvm + wasi-libc + wasi-runtimes), then
re-sign via fragment-tool as usual.

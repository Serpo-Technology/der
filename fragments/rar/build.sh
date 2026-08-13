#!/bin/sh
# Builds the RAR extraction part: libarchive's BSD-licensed RAR and RAR5
# readers compiled to wasm32-wasip1 (read-only file set; the write and
# disk modules never compile), wrapped by src/part.c into the DER ABI.
# Needs: brew install llvm wasi-libc wasi-runtimes cmake
set -e
cd "$(dirname "$0")"

LA_VERSION=3.7.7
LA_SHA256=879acd83c3399c7caaee73fe5f7418e06087ab2aaf40af3e99b9e29beb29faee
SYSROOT="${WASI_SYSROOT:-$(brew --prefix wasi-libc)/share/wasi-sysroot}"
LLVM="${LLVM_BIN:-$(brew --prefix llvm)/bin}"

mkdir -p vendor
TARBALL="vendor/libarchive-$LA_VERSION.tar.xz"
if [ ! -f "$TARBALL" ]; then
  curl -sL -o "$TARBALL" "https://github.com/libarchive/libarchive/releases/download/v$LA_VERSION/libarchive-$LA_VERSION.tar.xz"
fi
echo "$LA_SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null
[ -d "vendor/libarchive-$LA_VERSION" ] || tar xf "$TARBALL" -C vendor

# cmake runs feature detection against the wasi toolchain purely to
# generate config.h; the curated compile below never builds its targets.
if [ ! -f build/config.h ]; then
  mkdir -p build
  (cd build && cmake "../vendor/libarchive-$LA_VERSION" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_TOOLCHAIN_FILE=../wasi-toolchain.cmake \
    -DCMAKE_BUILD_TYPE=Release -DLIBGCC_LIBRARY="" -DLIBMD_LIBRARY="" >/dev/null)
fi

LA="vendor/libarchive-$LA_VERSION/libarchive"
"$LLVM/clang" --target=wasm32-wasip1 --sysroot="$SYSROOT" \
  -O2 -DHAVE_CONFIG_H -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -D'mkstemp(t)=(-1)' \
  -I build -I "$LA" \
  src/part.c \
  "$LA/archive_read.c" "$LA/archive_read_open_filename.c" \
  "$LA/archive_read_support_format_rar.c" "$LA/archive_read_support_format_rar5.c" \
  "$LA/archive_string.c" "$LA/archive_string_sprintf.c" "$LA/archive_util.c" \
  "$LA/archive_virtual.c" "$LA/archive_check_magic.c" "$LA/archive_entry.c" \
  "$LA/archive_entry_sparse.c" "$LA/archive_entry_xattr.c" "$LA/archive_acl.c" \
  "$LA/archive_rb.c" "$LA/archive_ppmd7.c" "$LA/archive_blake2s_ref.c" "$LA/archive_blake2sp_ref.c" \
  -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks \
  -mexec-model=reactor -Wl,--export=der_alloc -Wl,--export=der_run -Wl,--export-memory \
  -Wl,-z,stack-size=4194304 -Wl,--stack-first \
  -o rar.wasm
echo "wrote rar.wasm ($(wc -c < rar.wasm | tr -d ' ') bytes)"

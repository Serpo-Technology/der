# RAR extraction part

`der-labs.rar` opens RAR and RAR5 archives from picked files: `rar.list`
answers the entries, `rar.extract` produces one entry as a file grant.

Extraction only, by license: the RAR compressor is closed source and the
unrar license forbids re-creating the algorithm, so no part can ever
write the format. This part does not even use RARLAB sources: it builds
on libarchive's independent, BSD-licensed RAR readers (version and
sha256 pinned in `build.sh`), compiled to wasm32-wasip1 as a read-only
file set. Password-protected archives are refused with a readable
message. The test fixtures under `platform/host/tests/fixtures/rar/`
are decoded from libarchive's own BSD-licensed test corpus.

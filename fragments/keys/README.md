# Publisher keys

This directory holds Ed25519 publisher keypairs for signing part bundles.
Private keys (`*.key`) are gitignored and never leave this machine; only
fingerprints are public.

`der-labs.key` / `der-labs.pub` is the key behind every `der-labs.*` part in
`fragments/dist`. Its fingerprint, which installs pin on first use:

```text
d890 42e1 fc81 a0a3 1a29 a0bc 7785 4670 46f8 8878 802f 8660 0100 2416 f8cf 0e09
```

Losing this key means future der-labs releases cannot update existing
installs (the trust store hard-blocks key changes), so keep an offline
backup. `demo.key` / `demo.pub` are the same pair under the older name.

Any publisher generates their own pair with the signing tool:

```bash
cargo run -p fragment-tool -- keygen --out-dir keys --name <publisher>
```

Signing and indexing:

```bash
cargo run -p fragment-tool -- bundle --manifest <part>/manifest.json --wasm <part>.wasm --key keys/<publisher>.key --out dist/<id>.derpart
cargo run -p fragment-tool -- index --dir dist --out dist/index.json
```

`dist/` is a complete static registry: serve `index.json` and the bundles
from any web host and point the Parts view at the index URL. Transport is
untrusted by design; every install verifies the signature locally.

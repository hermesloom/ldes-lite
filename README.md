# ldes-lite

A minimal [Linked Data Event Stream](https://w3id.org/ldes/specification) server:
append-only, file-based storage, Ed25519-signed immutable pages, rsync-friendly
by design.

Stack: Node.js 24 (native TypeScript, no build step), `n3` for RDF parsing,
`rdf-validate-shacl` for SHACL enforcement, built-in `node:crypto` for signing,
Caddy for TLS and reverse proxy.

## What it does

- Accepts N-Quads via `POST /ingest` (bearer-token-authenticated)
- Validates ingested members against a configurable SHACL shape
- Appends to the currently-open node file (`nodes/NNNNNNNNNN.nq`)
- When a node crosses a size threshold, closes it durably (fsync + fsync dir),
  marks it `0444` immutable, writes an Ed25519 signature sidecar (`.nq.sig`),
  and rewrites `root.nq` atomically to link the new immutable node via
  `tree:relation`
- Serves everything as N-Quads with correct `Cache-Control: immutable` for
  frozen pages

## Deployment

Fresh Ubuntu 24.04 or 26.04 as root:

    git clone https://github.com/YOUR-USER/ldes-lite.git
    cd ldes-lite
    sudo bash scripts/setup.sh

Then edit `/var/lib/ldes-lite/config.json` and `/etc/caddy/Caddyfile` for your
domain, `systemctl start ldes-lite`, `systemctl reload caddy`.

## Layout on disk

    /opt/ldes-lite/                    # code (owned root:ldes, read-only for ldes)
    /var/lib/ldes-lite/
      config.json                      # server config
      shape.ttl                        # SHACL shape members must conform to
      ingest.token                     # bearer token for POST /ingest
      keys/
        ed25519.key                    # Ed25519 private key (400, root)
        ed25519.pub                    # public key, served at /pubkey
      data/
        root.nq                        # LDES root Node, rewritten on rotation
        nodes/
          0000000001.nq                # immutable, 0444
          0000000001.nq.sig            # signature sidecar
          ...
          0000000042.nq                # currently open, 0644

## HTTP surface

- `GET /root` — LDES root node with `tree:relation` links to all immutable nodes
- `GET /nodes/NNNNNNNNNN` — a specific node (`Cache-Control: immutable` if frozen)
- `GET /nodes/NNNNNNNNNN.sig` — signature sidecar
- `GET /pubkey` — public verification key (PEM)
- `GET /health` — JSON health probe (no auth): `status`, `openNodeNumber`,
  `openNodeSize`, `nodeCount`, `uptimeSeconds`
- `POST /ingest` — appends members (requires `Authorization: Bearer <token>`)

## License

MIT

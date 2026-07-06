# Claude context for ldes-lite

## What this project is

A minimal [Linked Data Event Stream](https://w3id.org/ldes/specification)
server. Append-only, file-based storage. Immutable nodes are byte-frozen and
Ed25519-signed. rsync-friendly by design.

## Runtime constraints (important)

Node.js 24 with **native TypeScript strip-only mode**. This means:

- **No parameter properties** in constructors (e.g. `constructor(private x: T)`
  is banned; write `constructor(x: T) { this.x = x }` instead)
- **No `enum`** — use string literal unions
- **No `namespace`** blocks
- **No decorators**
- **No `import x = require(...)`**
- Type annotations, interfaces, generics, `as` casts, `satisfies` are fine

## Development workflow

- Type-check: `npm run check` (runs `tsc --noEmit`). Must pass.
- Run locally: `npm start`
- Node 24 runs `.ts` files directly; no build step. Imports must include
  the `.ts` extension: `import { foo } from "./bar.ts"`

## Architecture invariants

Do not weaken any of the following without a very clear reason:

1. **Immutable nodes are byte-identical forever.** Once a node is closed
   (chmod 0444), its contents must never change. Bytes are what the signature
   is over.
2. **N-Quads is the on-disk format.** Line-oriented, append-safe. Don't
   introduce Turtle or JSON-LD as storage — only as request/response formats
   if content negotiation is added.
3. **fsync ordering matters.** In `writer.ts::rotate()`, the sequence
   fsync-file → close → chmod → sign → fsync-dir → rewrite-root → fsync-dir →
   open-next → fsync-dir is chosen so a crash at any step is recoverable on
   next boot. Startup recovery re-runs signing for any immutable node that
   lacks a `.sig` sidecar.
4. **Atomic root writes.** `root.nq` is rewritten via write-tmp + rename +
   fsync-dir. Never edit in place.
5. **No blank nodes.** All subjects and objects are IRIs. This keeps
   canonicalization trivial (sort quads lexicographically) and signatures
   robust.

## Filesystem layout at runtime

- `/opt/ldes-lite/` — code, owned `root:ldes`, group-readable
- `/var/lib/ldes-lite/` — data, config, keys, owned `ldes:ldes`
- systemd service runs as user `ldes`

## What NOT to commit

Never commit any of these to git:
- `/var/lib/ldes-lite/config.json` (the real one — use `config.example.json`)
- `/var/lib/ldes-lite/keys/ed25519.key` (private key)
- `/var/lib/ldes-lite/ingest.token`
- `/var/lib/ldes-lite/data/`
- Any real domain names or IP addresses

## When implementing an issue

1. Read the issue carefully; ask for clarification via comment if underspecified
2. Make the smallest change that solves the issue
3. Run `npm run check` and fix any type errors
4. Preserve the architecture invariants above
5. Update README.md if you change the HTTP surface or on-disk layout
6. If touching `writer.ts`, be very careful about the fsync sequence

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Parser as N3Parser, type Quad } from "n3";
import { loadConfig, type Config } from "./config.ts";
import { NodeWriter } from "./writer.ts";
import { loadValidator, type ShapeValidator } from "./shacl.ts";
import { loadSigner } from "./signer.ts";

const NQUADS = "application/n-quads";
const NODE_PATH_PATTERN = /^\/nodes\/(\d{10})$/;
const SIG_PATH_PATTERN = /^\/nodes\/(\d{10})\.sig$/;

const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const VERSION = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version: string }).version;
const SERVER_HEADER = `ldes-lite/${VERSION}`;

const HELLO_HTML = Buffer.from(
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ldes-lite</title>
</head>
<body>
<h1>Hello, world!</h1>
<p>This is an <a href="https://w3id.org/ldes/specification">ldes-lite</a> server.</p>
<ul>
<li><a href="/root">/root</a> — LDES root node</li>
<li><a href="/health">/health</a> — health probe</li>
<li><a href="/pubkey">/pubkey</a> — public signing key</li>
</ul>
</body>
</html>
`,
);

interface Context {
  config: Config;
  writer: NodeWriter;
  validator: ShapeValidator;
}

function serveHello(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": HELLO_HTML.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : HELLO_HTML);
}

async function serveRoot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const path = join(ctx.config.dataDir, "root.nq");
  const [body, info] = await Promise.all([readFile(path), stat(path)]);
  res.writeHead(200, {
    "Content-Type": NQUADS,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Last-Modified": info.mtime.toUTCString(),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveNode(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  nodeNumber: number,
): Promise<void> {
  const node = ctx.writer.getNodeInfo(nodeNumber);
  if (!node) {
    res.writeHead(404);
    res.end("Not Found\n");
    return;
  }

  const path = join(ctx.config.dataDir, "nodes", node.filename);
  const [body, info] = await Promise.all([readFile(path), stat(path)]);
  const cacheControl = node.immutable
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  res.writeHead(200, {
    "Content-Type": NQUADS,
    "Content-Length": body.length,
    "Cache-Control": cacheControl,
    "Last-Modified": info.mtime.toUTCString(),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveSig(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  nodeNumber: number,
): Promise<void> {
  const node = ctx.writer.getNodeInfo(nodeNumber);
  if (!node || !node.signed) {
    res.writeHead(404);
    res.end("Not Found\n");
    return;
  }

  const path = join(ctx.config.dataDir, "nodes", `${node.filename}.sig`);
  const [body, info] = await Promise.all([readFile(path), stat(path)]);

  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Content-Length": body.length,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Last-Modified": info.mtime.toUTCString(),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveHealth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = Buffer.from(JSON.stringify({
    status: "ok",
    openNodeNumber: ctx.writer.openNodeNumber,
    openNodeSize: ctx.writer.openNodeSize,
    nodeCount: ctx.writer.nodeCount,
    uptimeSeconds: Math.floor(process.uptime()),
  }) + "\n");
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function servePubkey(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  if (!ctx.config.publicKeyFile) {
    res.writeHead(404);
    res.end("Not Found\n");
    return;
  }
  const [body, info] = await Promise.all([
    readFile(ctx.config.publicKeyFile),
    stat(ctx.config.publicKeyFile),
  ]);
  res.writeHead(200, {
    "Content-Type": "application/x-pem-file",
    "Content-Length": body.length,
    "Cache-Control": "public, max-age=3600",
    "Last-Modified": info.mtime.toUTCString(),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseQuads(text: string): { ok: true; quads: Quad[] } | { ok: false; error: string } {
  try {
    const parser = new N3Parser({ format: "N-Quads" });
    const quads = parser.parse(text);
    if (quads.length === 0) return { ok: false, error: "empty body — at least one quad required" };
    return { ok: true, quads };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Constant-time comparison. Returns false immediately if lengths differ,
 *  which is technically a small side channel on length, but for a token of
 *  known-fixed length that's fine. */
function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  // ── Auth check ────────────────────────────────────────────────
  if (ctx.config.ingestToken !== null) {
    const authHeader = req.headers["authorization"];
    const expected = `Bearer ${ctx.config.ingestToken}`;
    if (typeof authHeader !== "string" || !tokensMatch(expected, authHeader)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Bearer realm="ldes-lite ingest"',
        "Content-Type": "text/plain",
      });
      res.end("Unauthorized\n");
      return;
    }
  }

  const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== NQUADS) {
    res.writeHead(415, { "Accept-Post": NQUADS });
    res.end(`Send Content-Type: ${NQUADS}\n`);
    return;
  }

  const body = await readBody(req);
  const parsed = parseQuads(body.toString("utf8"));
  if (!parsed.ok) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Parse error: ${parsed.error}\n`);
    return;
  }

  const validation = await ctx.validator.validate(parsed.quads);
  if (!validation.ok) {
    res.writeHead(422, { "Content-Type": "text/plain" });
    res.end(`SHACL validation failed:\n  ${validation.errors.join("\n  ")}\n`);
    return;
  }

  const toWrite = body.length > 0 && body[body.length - 1] === 0x0a
    ? body
    : Buffer.concat([body, Buffer.from("\n")]);

  await ctx.writer.append(toWrite);

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `ingested ${parsed.quads.length} quad(s); ` +
    `open node ${ctx.writer.openNodeNumber} is now ${ctx.writer.openNodeSize} bytes\n`,
  );
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" || req.method === "HEAD") {
    if (url.pathname === "/") return serveHello(req, res);
    if (url.pathname === "/root") return serveRoot(req, res, ctx);
    if (url.pathname === "/pubkey") return servePubkey(req, res, ctx);
    if (url.pathname === "/health") return serveHealth(req, res, ctx);

    const sigMatch = SIG_PATH_PATTERN.exec(url.pathname);
    if (sigMatch) {
      return serveSig(req, res, ctx, parseInt(sigMatch[1]!, 10));
    }
    const nodeMatch = NODE_PATH_PATTERN.exec(url.pathname);
    if (nodeMatch) {
      return serveNode(req, res, ctx, parseInt(nodeMatch[1]!, 10));
    }
    res.writeHead(404);
    res.end("Not Found\n");
    return;
  }

  if (req.method === "POST" && url.pathname === "/ingest") {
    return handleIngest(req, res, ctx);
  }

  res.writeHead(405, { "Allow": "GET, HEAD, POST" });
  res.end("Method Not Allowed\n");
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const signer = await loadSigner(config.privateKeyFile);
  const writer = new NodeWriter({
    nodesDir: join(config.dataDir, "nodes"),
    dataDir: config.dataDir,
    baseIri: config.baseIri,
    nodeSizeBytes: config.nodeSizeBytes,
    signer,
  });
  await writer.open();

  const validator = await loadValidator(config.shapeFile);

  if (config.ingestToken) {
    console.log("ingest requires bearer token");
  } else {
    console.log("WARNING: ingest is OPEN (no token configured)");
  }

  const ctx: Context = { config, writer, validator };

  const server = createServer((req, res) => {
    res.setHeader("Server", SERVER_HEADER);
    handle(req, res, ctx).catch((err) => {
      console.error("unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error\n");
      }
    });
  });

  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`ldes-lite listening on ${config.listenHost}:${config.listenPort}`);
    console.log(`baseIri: ${config.baseIri}`);
  });

  const shutdown = async () => {
    console.log("shutting down…");
    server.close();
    await writer.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("startup failed:", err);
  process.exit(1);
});

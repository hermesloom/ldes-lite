import { open, readdir, stat, chmod, rename, writeFile, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fsyncDir } from "./fsync.ts";
import type { Signer } from "./signer.ts";

const NODE_FILE_PATTERN = /^(\d{10})\.nq$/;
const IMMUTABLE_MODE = 0o444;
const OPEN_MODE = 0o644;

function parseNodeNumber(filename: string): number | null {
  const match = NODE_FILE_PATTERN.exec(filename);
  return match ? parseInt(match[1]!, 10) : null;
}

function formatNodeNumber(n: number): string {
  return n.toString().padStart(10, "0");
}

export interface NodeInfo {
  filename: string;
  number: number;
  immutable: boolean;
  signed: boolean;    // true iff a .sig sidecar exists
}

export class NodeWriter {
  private readonly nodesDir: string;
  private readonly dataDir: string;
  private readonly baseIri: string;
  private readonly nodeSizeBytes: number;
  private readonly signer: Signer | null;

  private handle: FileHandle | null = null;
  private currentNumber = 0;
  private currentSize = 0;
  private allNodes: NodeInfo[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: {
    nodesDir: string;
    dataDir: string;
    baseIri: string;
    nodeSizeBytes: number;
    signer: Signer | null;
  }) {
    this.nodesDir = opts.nodesDir;
    this.dataDir = opts.dataDir;
    this.baseIri = opts.baseIri;
    this.nodeSizeBytes = opts.nodeSizeBytes;
    this.signer = opts.signer;
  }

  async open(): Promise<void> {
    const entries = await readdir(this.nodesDir);
    const sigFiles = new Set(entries.filter((e) => e.endsWith(".nq.sig")));
    const infos: NodeInfo[] = [];
    for (const entry of entries) {
      const num = parseNodeNumber(entry);
      if (num === null) continue;
      const info = await stat(join(this.nodesDir, entry));
      const immutable = (info.mode & 0o777) === IMMUTABLE_MODE;
      const signed = sigFiles.has(`${entry}.sig`);
      infos.push({ filename: entry, number: num, immutable, signed });
    }
    infos.sort((a, b) => a.number - b.number);

    // Recovery: any immutable node without a signature gets signed now.
    if (this.signer) {
      for (const node of infos) {
        if (node.immutable && !node.signed) {
          console.log(`recovery: signing ${node.filename}`);
          await this.writeSignature(node.filename);
          node.signed = true;
        }
      }
    }

    const openNode = infos.find((n) => !n.immutable);
    if (openNode) {
      this.currentNumber = openNode.number;
    } else {
      const lastNumber = infos.length > 0 ? infos[infos.length - 1]!.number : 0;
      this.currentNumber = lastNumber + 1;
      const newFilename = `${formatNodeNumber(this.currentNumber)}.nq`;
      infos.push({
        filename: newFilename,
        number: this.currentNumber,
        immutable: false,
        signed: false,
      });
    }

    this.allNodes = infos;

    const path = join(this.nodesDir, `${formatNodeNumber(this.currentNumber)}.nq`);
    this.handle = await open(path, "a+", OPEN_MODE);
    const info = await this.handle.stat();
    this.currentSize = info.size;

    await this.rewriteRoot();

    console.log(
      `open node: ${formatNodeNumber(this.currentNumber)}.nq (${this.currentSize} bytes); ` +
      `${infos.length} node(s) total`,
    );
  }

  async append(data: Buffer): Promise<void> {
    const next = this.writeChain.then(async () => {
      if (!this.handle) throw new Error("writer not open");
      await this.handle.write(data);
      this.currentSize += data.length;
      if (this.currentSize >= this.nodeSizeBytes) {
        await this.rotate();
      }
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async rotate(): Promise<void> {
    if (!this.handle) throw new Error("writer not open");

    const closingNumber = this.currentNumber;
    const closingFilename = `${formatNodeNumber(closingNumber)}.nq`;
    const closingPath = join(this.nodesDir, closingFilename);

    // 1. fsync file data
    await this.handle.sync();
    // 2. close the fd
    await this.handle.close();
    this.handle = null;
    // 3. chmod immutable
    await chmod(closingPath, IMMUTABLE_MODE);
    // 4. write .sig sidecar (data-durable via its own fsync inside writeSignature)
    if (this.signer) {
      await this.writeSignature(closingFilename);
    }
    // 5. fsync directory so mode change + new sidecar are durable
    await fsyncDir(this.nodesDir);

    const closed = this.allNodes.find((n) => n.number === closingNumber)!;
    closed.immutable = true;
    closed.signed = this.signer !== null;

    const nextNumber = closingNumber + 1;
    const nextFilename = `${formatNodeNumber(nextNumber)}.nq`;
    this.allNodes.push({
      filename: nextFilename,
      number: nextNumber,
      immutable: false,
      signed: false,
    });

    // 6. rewrite root.nq atomically
    await this.rewriteRoot();

    // 7. open the next node
    const nextPath = join(this.nodesDir, nextFilename);
    this.handle = await open(nextPath, "a+", OPEN_MODE);
    await fsyncDir(this.nodesDir);
    this.currentNumber = nextNumber;
    this.currentSize = 0;

    console.log(`rotated: closed ${closingFilename}, opened ${nextFilename}`);
  }

  /**
   * Sign the frozen node file and write a base64 signature as a .sig sidecar.
   * The signature covers the raw file bytes. Sidecar is written atomically
   * (tmp + rename), chmod'd 0444, and fsync'd.
   */
  private async writeSignature(filename: string): Promise<void> {
    if (!this.signer) return;

    const nodePath = join(this.nodesDir, filename);
    const sigPath = `${nodePath}.sig`;
    const tmpPath = `${sigPath}.tmp`;

    const bytes = await readFile(nodePath);
    const sigB64 = this.signer.sign(bytes);

    // Human-readable single-line format: algorithm + base64 signature.
    const content = `ed25519 ${sigB64}\n`;
    await writeFile(tmpPath, content, { mode: OPEN_MODE });

    const tmpFd = await open(tmpPath, "r+");
    try { await tmpFd.sync(); } finally { await tmpFd.close(); }

    await rename(tmpPath, sigPath);
    await chmod(sigPath, IMMUTABLE_MODE);
  }

  private async rewriteRoot(): Promise<void> {
    const rootIri = `${this.baseIri}root`;

    const lines: string[] = [
      `<${rootIri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ldes#EventStream> .`,
      `<${rootIri}> <https://w3id.org/tree#view> <${rootIri}> .`,
      `<${rootIri}> <https://w3id.org/ldes#timestampPath> <http://www.w3.org/ns/prov#generatedAtTime> .`,
      `<${rootIri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/tree#Node> .`,
    ];

    for (const node of this.allNodes) {
      if (!node.immutable) continue;
      const nodeIri = `${this.baseIri}nodes/${formatNodeNumber(node.number)}`;
      const relIri = `${this.baseIri}relations/to-${formatNodeNumber(node.number)}`;
      lines.push(
        `<${rootIri}> <https://w3id.org/tree#relation> <${relIri}> .`,
        `<${relIri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/tree#Relation> .`,
        `<${relIri}> <https://w3id.org/tree#node> <${nodeIri}> .`,
      );
    }

    const content = lines.join("\n") + "\n";
    const finalPath = join(this.dataDir, "root.nq");
    const tmpPath = join(this.dataDir, "root.nq.tmp");

    await writeFile(tmpPath, content, { mode: OPEN_MODE });
    const tmpFd = await open(tmpPath, "r+");
    try { await tmpFd.sync(); } finally { await tmpFd.close(); }

    await rename(tmpPath, finalPath);
    await fsyncDir(this.dataDir);
  }

  async close(): Promise<void> {
    await this.writeChain.catch(() => {});
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = null;
    }
  }

  getNodeInfo(number: number): NodeInfo | undefined {
    return this.allNodes.find((n) => n.number === number);
  }
  get openNodeNumber(): number { return this.currentNumber; }
  get openNodeSize(): number { return this.currentSize; }
}

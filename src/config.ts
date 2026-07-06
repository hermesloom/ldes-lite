import { readFile } from "node:fs/promises";

export interface Config {
  baseIri: string;
  listenHost: string;
  listenPort: number;
  nodeSizeBytes: number;
  timestampPath: string;
  dataDir: string;
  shapeFile: string | null;
  privateKeyFile: string | null;
  publicKeyFile: string | null;
  ingestToken: string | null;
}

const CONFIG_PATH = process.env.LDES_CONFIG ?? "/var/lib/ldes-lite/config.json";
const DATA_DIR = process.env.LDES_DATA_DIR ?? "/var/lib/ldes-lite/data";

interface RawConfig extends Partial<Omit<Config, "ingestToken">> {
  ingestTokenFile?: string;
}

export async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as RawConfig;

  const required: (keyof Config)[] = [
    "baseIri", "listenHost", "listenPort", "nodeSizeBytes", "timestampPath",
  ];
  for (const key of required) {
    if (parsed[key as keyof RawConfig] === undefined) {
      throw new Error(`config.json is missing "${key}"`);
    }
  }
  if (!parsed.baseIri!.endsWith("/")) {
    throw new Error(`baseIri must end with "/", got "${parsed.baseIri}"`);
  }

  let ingestToken: string | null = null;
  if (parsed.ingestTokenFile) {
    ingestToken = (await readFile(parsed.ingestTokenFile, "utf8")).trim();
    if (ingestToken.length < 16) {
      throw new Error(`ingest token in ${parsed.ingestTokenFile} is too short`);
    }
  }

  return {
    baseIri: parsed.baseIri!,
    listenHost: parsed.listenHost!,
    listenPort: parsed.listenPort!,
    nodeSizeBytes: parsed.nodeSizeBytes!,
    timestampPath: parsed.timestampPath!,
    dataDir: DATA_DIR,
    shapeFile: parsed.shapeFile ?? null,
    privateKeyFile: parsed.privateKeyFile ?? null,
    publicKeyFile: parsed.publicKeyFile ?? null,
    ingestToken,
  };
}

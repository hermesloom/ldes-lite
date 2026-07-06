import { readFile } from "node:fs/promises";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export interface Signer {
  sign(data: Buffer): string;   // returns base64 signature
}

const noopSigner: Signer = {
  sign: () => {
    throw new Error("no signer configured — should not have been called");
  },
};

export async function loadSigner(privateKeyFile: string | null): Promise<Signer | null> {
  if (privateKeyFile === null) {
    console.log("no private key configured; nodes will not be signed");
    return null;
  }

  const pem = await readFile(privateKeyFile, "utf8");
  const key: KeyObject = createPrivateKey(pem);

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected Ed25519 key, got ${key.asymmetricKeyType}`);
  }

  console.log(`loaded signing key: ${privateKeyFile}`);

  return {
    sign(data: Buffer): string {
      // Ed25519 signs directly (no separate hash); pass null as algorithm.
      const signature = sign(null, data, key);
      return signature.toString("base64");
    },
  };
}
// keep noopSigner referenced to satisfy strict unused-export checks
export const _noop = noopSigner;

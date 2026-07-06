import { readFile } from "node:fs/promises";
import { Parser as N3Parser, type Quad } from "n3";
import rdf from "@zazuko/env-node";
import SHACLValidator from "rdf-validate-shacl";

export interface ShapeValidator {
  validate(quads: Quad[]): Promise<{ ok: true } | { ok: false; errors: string[] }>;
}

const passThrough: ShapeValidator = {
  validate: async () => ({ ok: true }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessage(result: any): string {
  const msg = result.message;
  if (Array.isArray(msg) && msg.length > 0) {
    const first = msg[0];
    return typeof first === "string" ? first : first?.value ?? String(first);
  }
  if (typeof msg === "string") return msg;
  if (msg?.value) return msg.value;
  return result.sourceConstraintComponent?.value ?? "constraint violated";
}

export async function loadValidator(shapeFile: string | null): Promise<ShapeValidator> {
  if (shapeFile === null) {
    console.log("no shape file configured; ingest validation disabled");
    return passThrough;
  }

  const shapeText = await readFile(shapeFile, "utf8");
  const shapeQuads = new N3Parser({ format: "Turtle" }).parse(shapeText);

  const shapesDataset = rdf.dataset();
  for (const q of shapeQuads) shapesDataset.add(q);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validator = new (SHACLValidator as any)(shapesDataset, { factory: rdf });

  console.log(`loaded shape: ${shapeFile} (${shapeQuads.length} triples)`);

  return {
    async validate(quads: Quad[]) {
      const dataset = rdf.dataset();
      for (const q of quads) dataset.add(q);

      const report = await validator.validate(dataset);
      if (report.conforms) return { ok: true };

      const errors: string[] = [];
      for (const result of report.results) {
        const focus = result.focusNode?.value ?? "?";
        const path = result.path?.value ?? "?";
        errors.push(`${focus} / ${path}: ${extractMessage(result)}`);
      }
      return { ok: false, errors };
    },
  };
}

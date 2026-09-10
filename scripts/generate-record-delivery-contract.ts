import type { JSONSchema } from "json-schema-to-typescript";

import { compile } from "json-schema-to-typescript";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "oxfmt";
import { parse } from "yaml";

const rootDir = process.cwd();
const sourcePath = join(rootDir, "docs/record-delivery.openapi.yaml");
const outputPath = join(rootDir, "src/sync/record-delivery-contract.generated.ts");
const document = parse(await readFile(sourcePath, "utf8")) as OpenApiDocument;
const envelope = requireSchema(document, "RecordDeliveryEnvelope");
const recordContent = requireSchema(document, "RecordContent");
const definitions = document.components.schemas;
const runtimeSchema = resolveComponentReferences(
  { ...envelope, $schema: "https://json-schema.org/draft/2020-12/schema" },
  definitions,
) as JSONSchema;
const typeSchema = { ...runtimeSchema };
delete typeSchema.title;

const declarations = await compile(typeSchema, "SyncDeliveryEnvelope", {
  bannerComment: "",
  additionalProperties: false,
  ignoreMinAndMaxItems: true,
  style: { singleQuote: false },
});
const version = requireNumber(envelope.properties?.version?.const, "version");
const maximumBatchRecords = requireNumber(envelope.properties?.records?.maxItems, "maximum batch records");
const maximumDeliveryBytes = requireNumber(envelope["x-open-connector-maximum-body-bytes"], "maximum delivery bytes");
const maximumRecordBytes = requireNumber(envelope["x-open-connector-maximum-record-bytes"], "maximum record bytes");
const maximumAttributesBytes = requireNumber(
  recordContent.properties?.attributes?.["x-open-connector-maximum-bytes"],
  "maximum attributes bytes",
);
const source = `import type { Schema } from "@cfworker/json-schema";

/** Generated from docs/record-delivery.openapi.yaml. Do not hand-edit. */
export const recordDeliveryContract: {
  readonly version: ${version};
  readonly maximumBatchRecords: ${maximumBatchRecords};
  readonly maximumDeliveryBytes: ${maximumDeliveryBytes};
  readonly maximumRecordBytes: ${maximumRecordBytes};
  readonly maximumAttributesBytes: ${maximumAttributesBytes};
} = ${JSON.stringify(
  { version, maximumBatchRecords, maximumDeliveryBytes, maximumRecordBytes, maximumAttributesBytes },
  null,
  2,
)} as const;

export const recordDeliveryEnvelopeSchema: Schema = ${JSON.stringify(runtimeSchema, null, 2)};

${declarations}
export type SyncDeliveryRecord = SyncDeliveryEnvelope["records"][number];
`;
const formatted = await format(outputPath, source, { printWidth: 120, trailingComma: "all" });
if (formatted.errors.length > 0) throw new Error(formatted.errors[0]!.message);
const existing = await readOptional(outputPath);
if (process.argv.includes("--check")) {
  if (existing !== formatted.code)
    throw new Error("Record delivery contract is stale. Run npm run generate:delivery-contract.");
  console.log("Record delivery contract is up to date.");
} else if (existing !== formatted.code) {
  await writeFile(outputPath, formatted.code);
  console.log("Generated record delivery contract.");
} else {
  console.log("Record delivery contract is up to date.");
}

interface OpenApiDocument {
  components: { schemas: Record<string, OpenApiSchema> };
}

interface OpenApiSchema extends Record<string, unknown> {
  const?: unknown;
  maxItems?: unknown;
  properties?: Record<string, OpenApiSchema>;
}

function requireSchema(document: OpenApiDocument, name: string): OpenApiSchema {
  const schema = document.components.schemas[name];
  if (!schema) throw new Error(`Missing OpenAPI schema: ${name}.`);
  return schema;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name} in record delivery OpenAPI contract.`);
  }
  return value;
}

function resolveComponentReferences(value: unknown, definitions: Record<string, OpenApiSchema>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveComponentReferences(item, definitions));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (typeof object.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!object.$ref.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${object.$ref}.`);
    const name = object.$ref.slice(prefix.length);
    const referenced = definitions[name];
    if (!referenced) throw new Error(`Missing referenced OpenAPI schema: ${name}.`);
    return resolveComponentReferences(referenced, definitions);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, resolveComponentReferences(child, definitions)]),
  );
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

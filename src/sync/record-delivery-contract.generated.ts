import type { Schema } from "@cfworker/json-schema";

/** Generated from docs/record-delivery.openapi.yaml. Do not hand-edit. */
export const recordDeliveryContract: {
  readonly version: 1;
  readonly maximumBatchRecords: 50;
  readonly maximumDeliveryBytes: 16777216;
  readonly maximumRecordBytes: 8388608;
  readonly maximumAttributesBytes: 16384;
} = {
  version: 1,
  maximumBatchRecords: 50,
  maximumDeliveryBytes: 16777216,
  maximumRecordBytes: 8388608,
  maximumAttributesBytes: 16384,
} as const;

export const recordDeliveryEnvelopeSchema: Schema = {
  title: "Record delivery envelope",
  description: "A durable batch delivered by OpenConnector to one configured destination.",
  type: "object",
  additionalProperties: false,
  required: ["version", "batchId", "records"],
  "x-open-connector-maximum-body-bytes": 16777216,
  "x-open-connector-maximum-record-bytes": 8388608,
  properties: {
    version: {
      const: 1,
    },
    batchId: {
      type: "string",
      format: "uuid",
      description: "Stable batch identity. Retries preserve this value and the exact request body.",
    },
    records: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "eventId",
              "provider",
              "sourceId",
              "kind",
              "id",
              "revision",
              "operation",
              "contentHash",
              "content",
              "committedAt",
            ],
            properties: {
              eventId: {
                type: "string",
                format: "uuid",
                description: "Stable event identity used to deduplicate retries.",
              },
              provider: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              sourceId: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              kind: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              id: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              revision: {
                type: "integer",
                minimum: 1,
                maximum: 9007199254740991,
              },
              operation: {
                enum: ["added", "updated"],
              },
              contentHash: {
                type: "string",
                pattern: "^[0-9a-f]{64}$",
                description: "SHA-256 of the canonical JSON record content, or the last content for a deletion.",
              },
              content: {
                type: "object",
                additionalProperties: false,
                required: ["title", "body"],
                properties: {
                  title: {
                    type: "string",
                    minLength: 1,
                    pattern: "\\S",
                    description: "Descriptive plain-text title chosen by the sync for display and search.",
                  },
                  body: {
                    type: "string",
                    minLength: 1,
                    pattern: "\\S",
                    description: "Markdown body of the record.",
                  },
                  sourceUrl: {
                    type: "string",
                    format: "uri",
                    pattern: "^https?://",
                  },
                  sourceCreatedAt: {
                    type: "string",
                    format: "date-time",
                  },
                  sourceUpdatedAt: {
                    type: "string",
                    format: "date-time",
                  },
                  participants: {
                    type: "array",
                    maxItems: 1000,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["identities", "roles"],
                      properties: {
                        identities: {
                          type: "array",
                          minItems: 1,
                          maxItems: 16,
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["namespace", "id"],
                            properties: {
                              namespace: {
                                type: "string",
                                minLength: 1,
                                pattern: "\\S",
                              },
                              id: {
                                type: "string",
                                minLength: 1,
                                pattern: "\\S",
                              },
                            },
                          },
                        },
                        roles: {
                          type: "array",
                          minItems: 1,
                          maxItems: 32,
                          items: {
                            type: "string",
                            minLength: 1,
                            pattern: "\\S",
                          },
                        },
                        name: {
                          type: "string",
                          minLength: 1,
                          pattern: "\\S",
                        },
                      },
                    },
                  },
                  attributes: {
                    type: "object",
                    additionalProperties: true,
                    description: "Provider-defined JSON object, limited to 16 KiB when canonically serialized.",
                    "x-open-connector-maximum-bytes": 16384,
                  },
                  assetIds: {
                    type: "array",
                    maxItems: 1000,
                    uniqueItems: true,
                    description:
                      "Complete set of destination asset identifiers referenced by this record. Assets are uploaded independently before record delivery. Omission means no asset references.",
                    items: {
                      type: "string",
                      minLength: 1,
                      maxLength: 1024,
                      pattern: "\\S",
                    },
                  },
                },
              },
              committedAt: {
                type: "string",
                format: "date-time",
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: [
              "eventId",
              "provider",
              "sourceId",
              "kind",
              "id",
              "revision",
              "operation",
              "contentHash",
              "committedAt",
            ],
            properties: {
              eventId: {
                type: "string",
                format: "uuid",
                description: "Stable event identity used to deduplicate retries.",
              },
              provider: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              sourceId: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              kind: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              id: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                pattern: "\\S",
              },
              revision: {
                type: "integer",
                minimum: 1,
                maximum: 9007199254740991,
              },
              operation: {
                const: "deleted",
              },
              contentHash: {
                type: "string",
                pattern: "^[0-9a-f]{64}$",
                description: "SHA-256 of the canonical JSON record content, or the last content for a deletion.",
              },
              committedAt: {
                type: "string",
                format: "date-time",
              },
            },
          },
        ],
      },
    },
  },
  $schema: "https://json-schema.org/draft/2020-12/schema",
};

/**
 * A durable batch delivered by OpenConnector to one configured destination.
 */
export interface SyncDeliveryEnvelope {
  version: 1;
  /**
   * Stable batch identity. Retries preserve this value and the exact request body.
   */
  batchId: string;
  /**
   * @minItems 1
   * @maxItems 50
   */
  records: (
    | {
        /**
         * Stable event identity used to deduplicate retries.
         */
        eventId: string;
        provider: string;
        sourceId: string;
        kind: string;
        id: string;
        revision: number;
        operation: "added" | "updated";
        /**
         * SHA-256 of the canonical JSON record content, or the last content for a deletion.
         */
        contentHash: string;
        content: {
          /**
           * Descriptive plain-text title chosen by the sync for display and search.
           */
          title: string;
          /**
           * Markdown body of the record.
           */
          body: string;
          sourceUrl?: string;
          sourceCreatedAt?: string;
          sourceUpdatedAt?: string;
          /**
           * @maxItems 1000
           */
          participants?: {
            /**
             * @minItems 1
             * @maxItems 16
             */
            identities: {
              namespace: string;
              id: string;
            }[];
            /**
             * @minItems 1
             * @maxItems 32
             */
            roles: string[];
            name?: string;
          }[];
          /**
           * Provider-defined JSON object, limited to 16 KiB when canonically serialized.
           */
          attributes?: {
            [k: string]: unknown;
          };
          /**
           * Complete set of destination asset identifiers referenced by this record. Assets are uploaded independently before record delivery. Omission means no asset references.
           *
           * @maxItems 1000
           */
          assetIds?: string[];
        };
        committedAt: string;
      }
    | {
        /**
         * Stable event identity used to deduplicate retries.
         */
        eventId: string;
        provider: string;
        sourceId: string;
        kind: string;
        id: string;
        revision: number;
        operation: "deleted";
        /**
         * SHA-256 of the canonical JSON record content, or the last content for a deletion.
         */
        contentHash: string;
        committedAt: string;
      }
  )[];
}

export type SyncDeliveryRecord = SyncDeliveryEnvelope["records"][number];

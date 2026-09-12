import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { recordDeliveryContract, recordDeliveryEnvelopeSchema } from "./record-delivery-contract.generated.ts";

const validator = new Validator(recordDeliveryEnvelopeSchema, "2020-12", false);
const upsert = {
  eventId: "01991c55-a120-7394-aef7-b08403e90942",
  provider: "github",
  sourceId: "account:123",
  kind: "pull-request",
  id: "456",
  revision: 1,
  operation: "added",
  contentHash: "a".repeat(64),
  content: { title: "owner/repo #42: Fix pagination", body: "# Pull request" },
  committedAt: "2026-09-10T10:00:00.000Z",
};

describe("record delivery contract", () => {
  it.each([
    { assetIds: [], valid: true },
    { assetIds: ["invoice-123", "image-456"], valid: true },
    { assetIds: ["invoice-123", "invoice-123"], valid: false },
    { assetIds: [" "], valid: false },
    { assetIds: [42], valid: false },
    { assetIds: Array.from({ length: 1001 }, (_, i) => `asset-${i}`), valid: false },
  ])("validates destination asset references: $valid", ({ assetIds, valid }) => {
    expect(
      validator.validate({
        version: recordDeliveryContract.version,
        batchId: "01991c55-a120-7394-aef7-b08403e90943",
        records: [{ ...upsert, content: { ...upsert.content, assetIds } }],
      }).valid,
    ).toBe(valid);
  });

  it("accepts the documented upsert envelope", () => {
    expect(
      validator.validate({
        version: recordDeliveryContract.version,
        batchId: "01991c55-a120-7394-aef7-b08403e90943",
        records: [upsert],
      }).valid,
    ).toBe(true);
  });

  it.each([undefined, null, "", " \n\t", 42])("rejects an upsert without a non-blank title: %j", (title) => {
    const content = title === undefined ? { body: upsert.content.body } : { ...upsert.content, title };
    expect(
      validator.validate({
        version: recordDeliveryContract.version,
        batchId: "01991c55-a120-7394-aef7-b08403e90943",
        records: [{ ...upsert, content }],
      }).valid,
    ).toBe(false);
  });

  it("accepts content-free deletions", () => {
    const { content: _content, ...deleted } = upsert;
    const envelope = {
      version: recordDeliveryContract.version,
      batchId: "01991c55-a120-7394-aef7-b08403e90943",
      records: [{ ...deleted, operation: "deleted" }],
    };
    expect(validator.validate(envelope).valid).toBe(true);
  });

  it("enforces operation content and batch limits", () => {
    const deletedWithContent = { ...upsert, operation: "deleted" };
    expect(
      validator.validate({
        version: recordDeliveryContract.version,
        batchId: "01991c55-a120-7394-aef7-b08403e90943",
        records: [deletedWithContent],
      }).valid,
    ).toBe(false);
    expect(
      validator.validate({
        version: recordDeliveryContract.version,
        batchId: "01991c55-a120-7394-aef7-b08403e90943",
        records: Array.from({ length: recordDeliveryContract.maximumBatchRecords + 1 }, () => upsert),
      }).valid,
    ).toBe(false);
  });
});

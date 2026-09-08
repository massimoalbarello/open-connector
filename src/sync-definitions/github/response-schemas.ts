import { z } from "zod";

const actor = z.object({ login: z.string(), url: z.string(), id: z.string().optional() }).nullable();
const date = z.iso.datetime({ offset: true });
export const pullResponse: z.ZodType<Record<string, unknown>> = z.looseObject({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.url(),
  createdAt: date,
  updatedAt: date,
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  mergedAt: date.nullable(),
  closedAt: date.nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  repository: z.object({ id: z.string(), nameWithOwner: z.string(), url: z.url() }),
  author: actor,
});
export const commentResponse: z.ZodType<Record<string, unknown>> = z.object({
  id: z.string(),
  body: z.string(),
  url: z.url(),
  createdAt: date,
  updatedAt: date,
  author: actor,
});
export const reviewResponse: z.ZodType<Record<string, unknown>> = z.object({
  id: z.string(),
  body: z.string(),
  url: z.url(),
  submittedAt: date.nullable(),
  state: z.string(),
  author: actor,
});
export const commitResponse: z.ZodType<Record<string, unknown>> = z.object({
  commit: z.object({
    oid: z.string(),
    message: z.string(),
    url: z.url(),
    committedDate: date,
    author: z.object({ user: actor }).nullable(),
  }),
});
export const threadResponse: z.ZodType<Record<string, unknown>> = z.looseObject({
  id: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
});

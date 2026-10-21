import type { FastifyRequest } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { badRequest } from "./errors";

export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    throw badRequest(`${where}${issue?.message ?? "Invalid input"}`, r.error.issues);
  }
  return r.data;
}

export const body = <T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> => parse(schema, req.body);
export const query = <T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> => parse(schema, req.query);
export const params = <T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> => parse(schema, req.params);

/** Query-string booleans: "true"/"1" → true. */
export const zBool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v === "true" || v === "1"))
  .optional();

export const zInt = (min?: number, max?: number) => {
  let s = z.coerce.number().int();
  if (min !== undefined) s = s.min(min);
  if (max !== undefined) s = s.max(max);
  return s;
};

/** A date or a date and time ("2026-10-15", "2026-10-15T09:00:00Z"); anything else is a 400 that says so, not a failed save. */
export const zWhen = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Use a date and time like 2026-10-15T09:00:00Z");

/** Accepts "a,b" or ["a","b"]. */
export const zList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(",").map((x) => x.trim()).filter(Boolean)))
  .optional();

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  search: z.string().optional(),
  with_total: zBool,
});

export function pageInfo(q: { limit?: number; starting_after?: string; page?: number }, defaultLimit = 20) {
  const limit = Math.min(q.limit ?? defaultLimit, 1000);
  const offset = q.page ? (q.page - 1) * limit : 0;
  return { limit, offset, startingAfter: q.starting_after ?? null };
}

export function paginated<T extends { id: string }>(items: T[], limit: number, total?: number) {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page,
    next_starting_after: hasMore ? page[page.length - 1]!.id : null,
    ...(total !== undefined ? { total } : {}),
  };
}

/** The caller's address. Fastify only reads X-Forwarded-For from proxies TRUST_PROXY allows, so it can't be faked. */
export function clientIp(req: FastifyRequest): string {
  return req.ip ?? "";
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

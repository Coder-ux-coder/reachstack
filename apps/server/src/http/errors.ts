export class HttpError extends Error {
  statusCode: number;
  code?: string;
  details?: unknown;
  constructor(statusCode: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);
export const unauthorized = (message = "Unauthorized") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "You do not have enough permissions for this action") => new HttpError(403, message, "forbidden");
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`, "not_found");
export const conflict = (message: string) => new HttpError(409, message, "conflict");
export const tooMany = (message = "Too many requests") => new HttpError(429, message, "rate_limited");
export const paymentRequired = (message: string) => new HttpError(402, message, "payment_required");

export function assertFound<T>(value: T | null | undefined, what = "Resource"): T {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}

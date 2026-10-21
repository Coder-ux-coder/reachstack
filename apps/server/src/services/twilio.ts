// Minimal Twilio REST client (calls, SMS, phone numbers). Needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.
import { config } from "../env";
import { badRequest } from "../http/errors";

export const twilioConfigured = () => !!(config.twilio.accountSid && config.twilio.authToken);

export async function twilioRequest<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string | undefined>): Promise<T> {
  if (!twilioConfigured()) throw badRequest("Calls and SMS need Twilio. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.");
  const { accountSid, authToken } = config.twilio;
  const url = path.startsWith("https://") ? path : `https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`;
  const body = form ? new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => e[1] !== undefined)) : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return {} as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw badRequest(`Twilio: ${String(data.message ?? `HTTP ${res.status}`)}`);
  return data as T;
}

const COUNTRY_PREFIXES: Array<[string, string]> = [
  ["1", "US"], ["7", "RU"], ["20", "EG"], ["27", "ZA"], ["30", "GR"], ["31", "NL"], ["32", "BE"], ["33", "FR"], ["34", "ES"], ["36", "HU"],
  ["39", "IT"], ["40", "RO"], ["41", "CH"], ["43", "AT"], ["44", "GB"], ["45", "DK"], ["46", "SE"], ["47", "NO"], ["48", "PL"], ["49", "DE"],
  ["51", "PE"], ["52", "MX"], ["54", "AR"], ["55", "BR"], ["56", "CL"], ["57", "CO"], ["60", "MY"], ["61", "AU"], ["62", "ID"], ["63", "PH"],
  ["64", "NZ"], ["65", "SG"], ["66", "TH"], ["81", "JP"], ["82", "KR"], ["84", "VN"], ["86", "CN"], ["90", "TR"], ["91", "IN"], ["92", "PK"],
  ["351", "PT"], ["353", "IE"], ["358", "FI"], ["420", "CZ"], ["852", "HK"], ["886", "TW"], ["971", "AE"], ["972", "IL"], ["966", "SA"], ["234", "NG"],
];

/** ISO country of an E.164 number (longest matching calling code). */
export function countryOfNumber(e164: string): string | null {
  const digits = e164.replace(/[^\d]/g, "");
  let best: string | null = null;
  let bestLen = 0;
  for (const [prefix, cc] of COUNTRY_PREFIXES) {
    if (digits.startsWith(prefix) && prefix.length > bestLen) {
      best = cc;
      bestLen = prefix.length;
    }
  }
  return best;
}

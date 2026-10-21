// What a mail server's refusal says about the address, from its enhanced status code (5.1.1…) and its words. Used when
// an SMTP server refuses a recipient or a message while sending, and for bounce notices that come back later.

/**
 * hard: the address doesn't work (no such mailbox or domain, or it's disabled). soft: it may work later (mailbox full,
 * try again later, a problem with the message or a server). block: the receiving side refused the sender or the
 * message (policy, reputation, authentication, a sending limit), which says nothing about the address.
 */
export type RefusalKind = "hard" | "soft" | "block";

/** The first enhanced status code in a server's answer ("550 5.1.1 …" → "5.1.1"). */
export const enhancedCode = (text: string): string | null => /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? null;

/** The recipient's mailbox is full or over its storage quota. */
export const MAILBOX_FULL = /mailbox (is )?full|over (its |the |their )?quota|(mailbox|storage|disk) quota|insufficient (system )?storage|out of storage|exceeded (its |the |their )?storage/i;

// About the sending mailbox or its server, not the recipient: checked before the address words, since "sender address
// rejected: domain not found" is about the sender's domain.
const SENDER_SIDE = /sender|mail from|from address|envelope from|relay|sending (quota|limit)|limit for sending|daily (user )?sending|unauthenticated|not authenticated|authentication (is )?required/i;
const NO_ADDRESS =
  /user unknown|unknown user|no such (user|mailbox|recipient|address|account)|does ?n[o']t exist|address not found|(address|recipient|mailbox) (could ?n[o']t|can ?not|can't) be found|recipient not found|unknown recipient|invalid (recipient|mailbox|address)|mailbox not found|mailbox unavailable|no mailbox|not a valid (mailbox|recipient|address)|(mailbox|recipient|address|account) (is |has been )?(disabled|deactivated|inactive|closed)|recipient address rejected: (user unknown|access denied|address unknown)|address (is )?(blacklisted|suppressed)|on (the|our|a) suppression list|domain not found|host not found|no mx\b|unrouteable|nxdomain|no such domain|domain does not exist|non-?existent domain/i;
const POLICY = /spam|\bblocked\b|block ?list|black ?list|\blisted\b|reputation|policy|dmarc|\bspf\b|dkim|not authori[sz]ed|unauthori[sz]ed|denied|prohibited|abuse|virus|malware|phish/i;

/**
 * Sorts a refusal. A status code, when there is one, decides: 4.x.x is temporary, 5.7.x is a block, 5.1.x and 5.2.1
 * mean the address doesn't work, 5.2.2 is a full mailbox. Generic codes (5.0.0, 5.3.x, 5.5.x…) and answers without a
 * code are read by their words, and a refusal that says nothing useful counts as soft: a good lead is never written
 * off on a guess.
 */
export function refusalKind(status: string | null | undefined, words: string): RefusalKind {
  const code = status || enhancedCode(words) || "";
  if (code.startsWith("4.")) return "soft";
  // 5.1.7 and 5.1.8 are the sender's address or domain.
  if (code.startsWith("5.7.") || code === "5.1.7" || code === "5.1.8") return "block";
  if (code.startsWith("5.1.") || code === "5.2.1") return "hard";
  if (code === "5.2.2" || code === "5.2.3") return "soft";
  // The recipient's domain doesn't route (Microsoft says 5.4.4 or 5.4.310 for a domain that doesn't exist).
  if (code === "5.4.4" || code === "5.4.310") return "hard";
  if (code.startsWith("5.4.") && code !== "5.4.1") return "soft";
  if (SENDER_SIDE.test(words)) return "block";
  if (NO_ADDRESS.test(words)) return "hard";
  if (MAILBOX_FULL.test(words)) return "soft";
  if (POLICY.test(words)) return "block";
  return "soft";
}

import { eq } from "drizzle-orm";
import { ProviderCode } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { decrypt, decryptJson, encryptJson } from "../lib/crypto";
import type { OAuthTokens } from "./oauth";
import { SandboxDriver } from "./sandbox";
import { SmtpImapDriver } from "./smtp-imap";
import type { MailDriver } from "./types";

export type AccountRow = typeof schema.emailAccounts.$inferSelect;

export function isSandbox(account: Pick<AccountRow, "providerCode">): boolean {
  return account.providerCode === ProviderCode.SANDBOX;
}

/** Mail driver for a stored account (credentials are decrypted in memory only). */
export function driverFor(account: AccountRow): MailDriver {
  if (isSandbox(account)) return new SandboxDriver({ email: account.email, workspaceId: account.workspaceId });
  return new SmtpImapDriver({
    id: account.id,
    email: account.email,
    imap: account.imap,
    imapPassword: decrypt(account.imapPasswordEnc),
    smtp: account.smtp,
    smtpPassword: decrypt(account.smtpPasswordEnc),
    oauth: decryptJson<OAuthTokens>(account.oauthEnc),
    saveTokens: async (tokens) => {
      await db.update(schema.emailAccounts).set({ oauthEnc: encryptJson(tokens) }).where(eq(schema.emailAccounts.id, account.id));
    },
  });
}

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, json, ts } from "./_helpers";

/**
 * Local test mailboxes used by Sandbox accounts (provider 99). Every address is a mailbox here, so
 * campaigns, warmup, replies and bounces can be exercised end-to-end without a real mail server.
 */
export const sandboxMessages = sqliteTable(
  "sandbox_messages",
  {
    uid: integer("uid").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id"),
    mailbox: text("mailbox").notNull(), // lowercase address
    folder: text("folder").notNull(), // INBOX | Junk | Sent | Trash | Archive
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    fromAddress: text("from_address"),
    subject: text("subject"),
    raw: text("raw").notNull(),
    flags: json<string[]>("flags").notNull(),
    internalDate: ts("internal_date").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sandbox_mailbox_idx").on(t.mailbox, t.folder, t.uid), index("sandbox_ws_idx").on(t.workspaceId, t.createdAt)],
);

// Transport-neutral mail types shared by the SMTP/IMAP driver and the sandbox driver.

export interface Address {
  name?: string | null;
  address: string;
}

export interface OutgoingAttachment {
  filename: string;
  contentType?: string;
  path?: string;
  content?: Buffer | string;
  cid?: string;
}

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** RFC 5322 Message-ID including angle brackets. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: OutgoingAttachment[];
  date?: Date;
  /**
   * Who this transmission goes to (the SMTP envelope), when not everyone named in to, cc and bcc: the headers still
   * name them. A campaign email goes to its lead on its own and to its cc and bcc addresses as an untracked copy.
   */
  envelopeTo?: string[];
  /** Hints for the sandbox driver only (ignored by real transports). */
  sandbox?: { spamChance?: number; categoryChance?: number };
}

export interface SendResult {
  messageId: string;
  response?: string;
  accepted: string[];
  rejected: string[];
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null;
}

export interface FetchedMessage {
  folder: string;
  uid: number;
  raw: Buffer;
  flags: string[];
  internalDate: Date | null;
}

export interface FetchBatch {
  uidValidity: string;
  messages: FetchedMessage[];
  /** Highest UID seen in the folder (even when messages were skipped). */
  highestUid: number;
  /** UIDs the server wouldn't hand over this time (the rest of the batch came through). */
  failed?: number[];
}

/** An open mailbox connection used for one sync pass. */
export interface MailSession {
  folders(): Promise<FolderInfo[]>;
  /** Messages with UID > sinceUid. On first sync (sinceUid 0) only messages newer than `sinceDate`. */
  fetchNew(folder: string, sinceUid: number, opts: { uidValidity?: string | null; max: number; sinceDate?: Date }): Promise<FetchBatch>;
  /** Moves a message; returns its UID in `destination` when the server says (UIDPLUS), else null. */
  move(folder: string, uid: number, destination: string): Promise<number | null>;
  addFlags(folder: string, uid: number, flags: string[]): Promise<void>;
  append(folder: string, raw: Buffer, flags?: string[]): Promise<void>;
  /** Finds a message by its Message-ID header in the given folders (first match wins). */
  findByMessageId(messageId: string, folders: string[]): Promise<FetchedMessage | null>;
  /** Messages whose body contains `text`, received since `since` (newest first, at most `max`). */
  searchText(text: string, folders: string[], since: Date, max: number): Promise<FetchedMessage[]>;
  close(): Promise<void>;
}

export interface ConnectionCheck {
  ok: boolean;
  error?: string;
  code?: string;
  /** What to do about it, in plain words (./connection-hints). */
  hint?: string;
}

export interface MailDriver {
  readonly kind: "smtp-imap" | "sandbox";
  send(msg: OutgoingMessage): Promise<SendResult>;
  open(): Promise<MailSession>;
  verify(): Promise<{ smtp: ConnectionCheck; imap: ConnectionCheck }>;
  /** Signs in for sending only (the re-test of a mailbox taken out of sending needs nothing else). */
  verifySmtp(): Promise<ConnectionCheck>;
}

/** Errors raised by drivers, classified for the engine. */
export class MailError extends Error {
  /**
   * auth: credentials rejected; connection: host unreachable/timeouts; recipient: address rejected; quota: daily sending
   * limit at the provider; rejected: the provider refused mail from this mailbox (a sending block or policy); temporary: retry later
   */
  kind: "auth" | "connection" | "recipient" | "quota" | "rejected" | "temporary" | "unknown";
  responseCode?: number;
  command?: string;
  response?: string;
  /** A refused recipient whose address may work later (its mailbox is full): a soft bounce, tried again. */
  soft?: boolean;
  constructor(kind: MailError["kind"], message: string, extra: { responseCode?: number; command?: string; response?: string; soft?: boolean } = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

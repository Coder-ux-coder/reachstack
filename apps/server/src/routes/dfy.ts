// Done-for-you email account orders (API v2) and the administrator's fulfilment endpoints.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { ProviderCode } from "@reachstack/shared";
import { db, schema } from "../db/client";
import type { DfyMailbox } from "../db/schema/ops";
import { ctx } from "../http/context";
import { assertFound, badRequest } from "../http/errors";
import { body, query, zBool, zInt } from "../http/util";
import { decrypt, encrypt } from "../lib/crypto";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";
import { createAccount } from "../services/account-connect";
import {
  PREFIX_RE,
  PROVIDER_NAMES,
  checkDomains,
  domainAvailable,
  prewarmedInventory,
  pricing,
  providerCode,
  restrictedKeyword,
  similarDomains,
  validDfyDomain,
  type MailboxProvider,
} from "../services/dfy";
import { invalidateForwardingCache, isHostname, normalizeDomain } from "../services/domains";
import { requireInstanceAdmin, setAppSetting } from "../services/instance";

const O = schema.dfyOrders;
type OrderRow = typeof O.$inferSelect;

const accountSchema = z.object({ email_address_prefix: z.string().trim(), first_name: z.string().trim(), last_name: z.string().trim() });
const itemSchema = z.object({
  domain: z.string().min(3).max(253),
  email_provider: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  forwarding_domain: z.string().max(253).optional(),
  accounts: z.array(accountSchema).default([]),
});
const orderSchema = z.object({ items: z.array(itemSchema).min(1).max(100), order_type: z.enum(["dfy", "pre_warmed_up", "extra_accounts"]), simulation: z.boolean().default(false) });

function serializeOrder(o: OrderRow) {
  return {
    id: o.id,
    workspace_id: o.workspaceId,
    domain: o.domain,
    forwarding_domain: o.forwardingDomain,
    forwarding_mode: o.forwardingMode,
    is_pre_warmed_up: !!o.isPreWarmedUp,
    timestamp_cancelled: iso(o.cancelledAt),
    timestamp_created: iso(o.createdAt),
    // Extensions
    status: o.status,
    order_type: o.orderType,
    email_provider: providerCode(o.mailboxProvider),
    accounts_count: o.mailboxes.filter((m) => !m.cancelled_at).length,
    price_per_month: o.pricePerMonth,
  };
}

function serializeMailbox(o: OrderRow, m: DfyMailbox, withPassword: boolean) {
  return {
    id: m.id ?? `${o.id}:${m.email}`,
    domain: o.domain,
    email: m.email,
    email_provider: providerCode(o.mailboxProvider),
    first_name: m.first_name,
    last_name: m.last_name,
    is_pre_warmed_up: !!o.isPreWarmedUp,
    timestamp_cancelled: m.cancelled_at ?? null,
    timestamp_created: iso(o.createdAt),
    ...(withPassword ? { password: decrypt(m.password_enc) ?? "" } : {}),
  };
}

export default async function dfyRoutes(app: FastifyInstance) {
  const read = { scope: ["dfy_email_account_orders", "read"] as ["dfy_email_account_orders", "read"], perm: "accounts" as const };
  const create = { scope: ["dfy_email_account_orders", "create"] as ["dfy_email_account_orders", "create"], perm: "billing" as const, write: true };

  app.post("/api/v2/dfy-email-account-orders/domains/check", { config: read }, async (req) => {
    const b = body(req, z.object({ domains: z.array(z.string()).min(1).max(50) }));
    return { results: await checkDomains(b.domains) };
  });

  app.post("/api/v2/dfy-email-account-orders/domains/similar", { config: read }, async (req) => {
    const b = body(req, z.object({ domain: z.string().min(1).max(253), tlds: z.array(z.enum(["com", "org"])).optional() }));
    return { domains: await similarDomains(b.domain, b.tlds ?? ["com", "org"]) };
  });

  app.post("/api/v2/dfy-email-account-orders/domains/pre-warmed-up-list", { config: read }, async (req) => {
    const b = body(req, z.object({ extensions: z.array(z.enum(["com", "org", "co"])).optional(), search: z.string().optional() }));
    const ordered = new Set((await db.select({ domain: O.domain }).from(O).where(eq(O.isPreWarmedUp, true))).map((r) => r.domain));
    const exts = b.extensions?.length ? b.extensions : ["com", "org", "co"];
    const search = b.search?.toLowerCase().trim();
    const list = (await prewarmedInventory()).filter((d) => !ordered.has(d.domain) && exts.includes(d.domain.split(".").pop() as "com") && (!search || d.domain.includes(search)));
    return { domains: list.map((d) => d.domain), domains_with_type: list };
  });

  app.post("/api/v2/dfy-email-account-orders", { config: create }, async (req) => {
    const c = ctx(req);
    const b = body(req, orderSchema);
    const prices = await pricing();
    const inventory = new Map((await prewarmedInventory()).map((d) => [d.domain, d.account_type]));
    const existing = await db.select().from(O).where(eq(O.workspaceId, c.wsId));
    const existingByDomain = new Map<string, OrderRow[]>();
    for (const o of existing) if (!o.cancelledAt) existingByDomain.set(o.domain, [...(existingByDomain.get(o.domain) ?? []), o]);

    const r = {
      unavailable_domains: [] as string[],
      blacklist_domains: [] as string[],
      blacklist_keywords: [] as string[],
      invalid_domains: [] as string[],
      invalid_forwarding_domains: [] as string[],
      missing_domain_orders: [] as string[],
      provider_mismatch_domains: [] as string[],
      unsupported_provider_domains: [] as string[],
      unavailable_email_providers: [] as number[],
      domains_without_accounts: [] as string[],
      invalid_accounts: [] as Array<{ domain: string; first_name: string; last_name: string; email: string; reason: string }>,
    };
    const seen = new Set<string>();
    const orderItems: Array<{
      domain: string;
      email_provider: MailboxProvider;
      forwarding_domain?: string;
      accounts: Array<z.infer<typeof accountSchema>>;
      domain_price: number;
      accounts_price: number;
      domain_monthly_price: number | null;
      total_price: number;
      total_discount: number;
    }> = [];

    for (const item of b.items) {
      const domain = normalizeDomain(item.domain);
      if (seen.has(domain)) {
        r.invalid_domains.push(domain);
        continue;
      }
      seen.add(domain);
      const provider = item.email_provider as MailboxProvider;
      let accounts = item.accounts;
      if (b.order_type === "dfy") {
        const kw = restrictedKeyword(domain);
        if (kw) {
          r.blacklist_domains.push(domain);
          r.blacklist_keywords.push(kw);
          continue;
        }
        if (!validDfyDomain(domain)) {
          r.invalid_domains.push(domain);
          continue;
        }
        if ((await domainAvailable(domain)) !== true || existingByDomain.has(domain)) {
          r.unavailable_domains.push(domain);
          continue;
        }
      } else if (b.order_type === "pre_warmed_up") {
        if (!inventory.has(domain)) {
          r.unavailable_domains.push(domain);
          continue;
        }
        accounts = []; // pre-warmed domains come with their mailboxes
      } else {
        const prior = existingByDomain.get(domain);
        if (!prior) {
          r.missing_domain_orders.push(domain);
          continue;
        }
        if (prior.some((o) => providerCode(o.mailboxProvider) !== provider)) {
          r.provider_mismatch_domains.push(domain);
          continue;
        }
      }
      if (item.forwarding_domain) {
        const fwd = normalizeDomain(item.forwarding_domain);
        if (!isHostname(fwd) || fwd === domain) {
          r.invalid_forwarding_domains.push(item.forwarding_domain);
          continue;
        }
      }
      if (b.order_type !== "pre_warmed_up") {
        if (!accounts.length) {
          r.domains_without_accounts.push(domain);
          continue;
        }
        const existingCount = (existingByDomain.get(domain) ?? []).flatMap((o) => o.mailboxes.filter((m) => !m.cancelled_at)).length;
        const max = provider === 3 ? 100 : 5;
        const takenPrefixes = new Set((existingByDomain.get(domain) ?? []).flatMap((o) => o.mailboxes.map((m) => m.email.split("@")[0]!.toLowerCase())));
        let bad = false;
        for (const a of accounts) {
          const email = `${a.email_address_prefix.toLowerCase()}@${domain}`;
          const reason = !PREFIX_RE.test(a.email_address_prefix)
            ? "invalid_prefix"
            : !a.first_name || !a.last_name
              ? "missing_name"
              : takenPrefixes.has(a.email_address_prefix.toLowerCase())
                ? "duplicate"
                : null;
          if (reason) {
            r.invalid_accounts.push({ domain, first_name: a.first_name, last_name: a.last_name, email, reason });
            bad = true;
          }
          takenPrefixes.add(a.email_address_prefix.toLowerCase());
        }
        if (existingCount + accounts.length > max) {
          r.invalid_accounts.push({ domain, first_name: "", last_name: "", email: `*@${domain}`, reason: `max_${max}_accounts_per_domain` });
          bad = true;
        }
        if (bad) continue;
      }
      const domainPrice = b.order_type === "dfy" ? prices.domain_per_year : b.order_type === "pre_warmed_up" ? prices.prewarmed_domain_per_year : 0;
      const mailboxCount = b.order_type === "pre_warmed_up" ? 3 : accounts.length;
      const accountsPrice = provider === 3 ? (b.order_type === "extra_accounts" ? 0 : prices.microsoft_domain_per_month) : prices.mailbox_per_month[String(provider) as "1" | "2"] * mailboxCount;
      orderItems.push({
        domain,
        email_provider: provider,
        forwarding_domain: item.forwarding_domain ? normalizeDomain(item.forwarding_domain) : undefined,
        accounts,
        domain_price: domainPrice,
        accounts_price: round(accountsPrice),
        domain_monthly_price: provider === 3 ? prices.microsoft_domain_per_month : null,
        total_price: round(domainPrice + accountsPrice),
        total_discount: 0,
      });
    }

    const errorKey = (Object.keys(r) as Array<keyof typeof r>).find((k) => k !== "blacklist_keywords" && r[k].length);
    const valid = !errorKey && orderItems.length > 0;
    const totalAccountsMonthly = round(orderItems.reduce((s, i) => s + i.accounts_price, 0));
    const totalDomainsYearly = round(orderItems.reduce((s, i) => s + i.domain_price, 0));
    const providers = new Set(orderItems.map((i) => i.email_provider));
    let placed = false;
    if (valid && !b.simulation) {
      for (const item of orderItems) {
        const mailboxes: DfyMailbox[] = item.accounts.map((a) => ({ id: uuidv7(), first_name: a.first_name, last_name: a.last_name, email: `${a.email_address_prefix.toLowerCase()}@${item.domain}` }));
        await db.insert(O).values({
          workspaceId: c.wsId,
          domain: item.domain,
          forwardingDomain: item.forwarding_domain ?? null,
          forwardingMode: item.forwarding_domain ? "redirect" : null,
          isPreWarmedUp: b.order_type === "pre_warmed_up",
          mailboxProvider: PROVIDER_NAMES[item.email_provider],
          orderType: b.order_type,
          mailboxes,
          status: "pending",
          pricePerMonth: item.accounts_price,
          createdBy: c.userId,
        });
        if (item.forwarding_domain) {
          await db
            .insert(schema.domainForwarding)
            .values({ workspaceId: c.wsId, domain: item.domain, forwardingDomain: item.forwarding_domain, forwardingMode: "redirect" })
            .onConflictDoNothing();
          invalidateForwardingCache(item.domain);
        }
      }
      await db.insert(schema.notifications).values({
        workspaceId: c.wsId,
        userId: c.userId,
        type: "dfy_order",
        title: `Order received for ${orderItems.length} domain${orderItems.length === 1 ? "" : "s"}`,
        body: "Mailboxes are set up by the administrator of this installation. You'll see them under Email accounts once they're ready.",
        link: "/app/accounts?tab=dfy",
      });
      placed = true;
    }
    return {
      order_placed: placed,
      order_is_valid: valid,
      ...(errorKey ? { order_error: errorKey === "domains_without_accounts" ? "missing_accounts" : errorKey === "unavailable_email_providers" ? "unavailable_email_providers" : errorKey } : {}),
      ...r,
      free_domains: [],
      number_of_domains_ordered: placed ? orderItems.length : 0,
      number_of_accounts_ordered: placed ? orderItems.reduce((s, i) => s + i.accounts.length, 0) : 0,
      price_per_account_per_month: providers.size === 1 && !providers.has(3) ? (await pricing()).mailbox_per_month[String([...providers][0]) as "1" | "2"] : null,
      price_per_domain_per_month: providers.has(3) ? prices.microsoft_domain_per_month : null,
      price_per_domain_per_year: b.order_type === "pre_warmed_up" ? prices.prewarmed_domain_per_year : prices.domain_per_year,
      total_domains_price_per_year: totalDomainsYearly,
      total_accounts_price_per_month: totalAccountsMonthly,
      total_price_per_month: totalAccountsMonthly,
      total_price_per_year: round(totalAccountsMonthly * 12 + totalDomainsYearly),
      total_price: round(totalAccountsMonthly + totalDomainsYearly),
      total_discount: 0,
      payment_method_last_4_digits: "",
      payment_method_brand: "",
      payment_method_name_on_card: "",
      simulation: b.simulation,
      order_items: orderItems,
    };
  });

  app.get("/api/v2/dfy-email-account-orders", { config: read }, async (req) => {
    const q = query(req, z.object({ limit: zInt(1, 100).optional(), starting_after: z.string().optional() }));
    const c = ctx(req);
    const limit = q.limit ?? 20;
    const rows = await db
      .select()
      .from(O)
      .where(and(eq(O.workspaceId, c.wsId), q.starting_after ? lt(O.id, q.starting_after) : undefined))
      .orderBy(desc(O.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(serializeOrder), next_starting_after: rows.length > limit ? page[page.length - 1]!.id : null };
  });

  app.get("/api/v2/dfy-email-account-orders/accounts", { config: read }, async (req) => {
    const q = query(req, z.object({ limit: zInt(1, 500).optional(), starting_after: z.string().optional(), with_passwords: zBool }));
    const c = ctx(req);
    // Mailbox passwords are for the workspace's owners and admins (an API key needs this scope, which they create).
    if (q.with_passwords && !c.auth.apiKey) c.requireRole("owner", "admin");
    const orders = await db.select().from(O).where(eq(O.workspaceId, c.wsId)).orderBy(desc(O.id));
    const all = orders.flatMap((o) => o.mailboxes.map((m) => serializeMailbox(o, m, !!q.with_passwords)));
    const start = q.starting_after ? all.findIndex((a) => a.id === q.starting_after) + 1 : 0;
    const limit = q.limit ?? 100;
    const page = all.slice(start, start + limit);
    return { items: page, next_starting_after: start + limit < all.length ? page[page.length - 1]!.id : null };
  });

  app.post("/api/v2/dfy-email-account-orders/accounts/cancel", { config: { ...create, scope: ["dfy_email_account_orders", "update"] as ["dfy_email_account_orders", "update"] } }, async (req) => {
    const c = ctx(req);
    const b = body(req, z.object({ accounts: z.array(z.string()).min(1).max(1000) }));
    const wanted = new Set(b.accounts.map((e) => e.trim().toLowerCase()));
    const now = new Date().toISOString();
    const orders = await db.select().from(O).where(eq(O.workspaceId, c.wsId));
    const cancelled: ReturnType<typeof serializeMailbox>[] = [];
    for (const o of orders) {
      let changed = false;
      const mailboxes = o.mailboxes.map((m) => {
        if (!wanted.has(m.email.toLowerCase()) || m.cancelled_at) return m;
        changed = true;
        const next = { ...m, cancelled_at: now };
        cancelled.push(serializeMailbox(o, next, false));
        return next;
      });
      if (!changed) continue;
      const allCancelled = mailboxes.every((m) => m.cancelled_at);
      await db
        .update(O)
        .set({ mailboxes, ...(allCancelled ? { status: "cancelled", cancelledAt: new Date() } : {}) })
        .where(eq(O.id, o.id));
    }
    return { items: cancelled };
  });

  // ---------- Administrator: fulfilment, pricing and pre-warmed inventory ----------

  app.get("/api/app/admin/dfy-orders", { config: { auth: "user" } }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const q = query(req, z.object({ status: z.string().optional() }));
    const rows = await db
      .select({ order: O, workspaceName: schema.workspaces.name })
      .from(O)
      .leftJoin(schema.workspaces, eq(schema.workspaces.id, O.workspaceId))
      .where(q.status ? eq(O.status, q.status) : undefined)
      .orderBy(desc(O.createdAt))
      .limit(500);
    return rows.map((r) => ({ ...serializeOrder(r.order), workspace_name: r.workspaceName, mailboxes: r.order.mailboxes.map((m) => serializeMailbox(r.order, m, false)), notes: r.order.notes }));
  });

  /**
   * Marks an order fulfilled: stores each mailbox password (encrypted) and, when `connect` is set, connects
   * the mailboxes to the ordering workspace over IMAP/SMTP with warmup on.
   */
  app.post("/api/app/admin/dfy-orders/:id/fulfil", { config: { auth: "user" } }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const b = body(
      req,
      z.object({
        status: z.enum(["processing", "active", "failed", "cancelled"]).default("active"),
        notes: z.string().max(2000).optional(),
        mailboxes: z.array(z.object({ email: z.string(), password: z.string().min(1) })).default([]),
        connect: z.boolean().default(false),
        imap_host: z.string().optional(),
        imap_port: z.number().int().optional(),
        smtp_host: z.string().optional(),
        smtp_port: z.number().int().optional(),
      }),
    );
    const [row] = await db
      .select()
      .from(O)
      .where(eq(O.id, (req.params as { id: string }).id))
      .limit(1);
    const o = assertFound(row, "Order");
    const passwords = new Map(b.mailboxes.map((m) => [m.email.trim().toLowerCase(), m.password]));
    const mailboxes = o.mailboxes.map((m) => (passwords.has(m.email.toLowerCase()) ? { ...m, password_enc: encrypt(passwords.get(m.email.toLowerCase())!) } : m));
    await db
      .update(O)
      .set({ mailboxes, status: b.status, notes: b.notes ?? o.notes, ...(b.status === "cancelled" ? { cancelledAt: new Date() } : {}) })
      .where(eq(O.id, o.id));
    const connected: string[] = [];
    const errors: Array<{ email: string; error: string }> = [];
    if (b.connect && b.status === "active") {
      const provider = providerCode(o.mailboxProvider);
      const hosts =
        provider === 1
          ? { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 }
          : provider === 3
            ? { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp.office365.com", smtp_port: 587 }
            : { imap_host: b.imap_host, imap_port: b.imap_port ?? 993, smtp_host: b.smtp_host, smtp_port: b.smtp_port ?? 465 };
      if (!hosts.imap_host || !hosts.smtp_host) throw badRequest("imap_host and smtp_host are required for this mailbox provider");
      for (const m of mailboxes) {
        const password = decrypt(m.password_enc);
        if (!password || m.cancelled_at) continue;
        try {
          await createAccount(o.workspaceId, o.createdBy ?? null, {
            email: m.email,
            first_name: m.first_name,
            last_name: m.last_name,
            provider_code: provider === 1 ? ProviderCode.GOOGLE : provider === 3 ? ProviderCode.MICROSOFT : ProviderCode.AIRMAIL,
            imap_username: m.email,
            imap_password: password,
            imap_host: b.imap_host ?? hosts.imap_host,
            imap_port: b.imap_port ?? hosts.imap_port,
            smtp_username: m.email,
            smtp_password: password,
            smtp_host: b.smtp_host ?? hosts.smtp_host,
            smtp_port: b.smtp_port ?? hosts.smtp_port,
            enable_warmup: true,
          });
          connected.push(m.email);
        } catch (err) {
          errors.push({ email: m.email, error: (err as Error).message });
        }
      }
    }
    if (b.status === "active") {
      await db.insert(schema.notifications).values({
        workspaceId: o.workspaceId,
        userId: o.createdBy,
        type: "dfy_ready",
        title: `${o.domain} is ready`,
        body: connected.length ? `${connected.length} mailbox${connected.length === 1 ? " was" : "es were"} connected with warmup on.` : "Your mailboxes are ready to connect.",
        link: "/app/accounts",
      });
    }
    return { order: serializeOrder({ ...o, mailboxes, status: b.status }), connected, errors };
  });

  app.put("/api/app/admin/dfy-settings", { config: { auth: "user" } }, async (req) => {
    await requireInstanceAdmin(ctx(req).user);
    const b = body(
      req,
      z.object({
        pricing: z
          .object({
            domain_per_year: z.number().min(0),
            prewarmed_domain_per_year: z.number().min(0),
            mailbox_per_month: z.object({ "1": z.number().min(0), "2": z.number().min(0) }),
            microsoft_domain_per_month: z.number().min(0),
          })
          .optional(),
        prewarmed_inventory: z.array(z.object({ domain: z.string(), account_type: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).optional(),
      }),
    );
    if (b.pricing) await setAppSetting("dfy_pricing", b.pricing);
    if (b.prewarmed_inventory) await setAppSetting("dfy_prewarmed_inventory", b.prewarmed_inventory.map((d) => ({ ...d, domain: normalizeDomain(d.domain) })));
    return { pricing: await pricing(), prewarmed_inventory: await prewarmedInventory() };
  });

  app.get("/api/app/dfy/pricing", { config: { perm: "accounts" } }, async () => pricing());
}

const round = (n: number) => Math.round(n * 100) / 100;

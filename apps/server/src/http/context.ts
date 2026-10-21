import type { FastifyRequest } from "fastify";
import type { Permission, Role } from "@reachstack/shared";
import type { schema } from "../db/client";
import { forbidden, unauthorized } from "./errors";

export type User = typeof schema.users.$inferSelect;
export type Session = typeof schema.sessions.$inferSelect;
export type Workspace = typeof schema.workspaces.$inferSelect;
export type Member = typeof schema.workspaceMembers.$inferSelect;
export type ApiKey = typeof schema.apiKeys.$inferSelect;

/** What a workspace's security settings still ask of a session before it can be used (see workspaceGate in ./auth). */
export type WorkspaceGate = "totp_required" | "workspace_reauth_required";

export interface AuthContext {
  via: "none" | "session" | "api_key" | "oauth";
  user: User | null;
  session: Session | null;
  apiKey: ApiKey | null;
  workspace: Workspace | null;
  member: Member | null;
  role: Role | null;
  scopes: string[] | null;
  /** Set when the session's workspace asks for two-step authentication or a fresh code first. */
  gate: WorkspaceGate | null;
}

export type AuthMode = "public" | "user" | "workspace" | "mfa";

export interface RouteAuthConfig {
  /** public: no auth; user: logged-in user (no workspace needed); workspace (default): user or API key with a workspace; mfa: session awaiting 2FA */
  auth?: AuthMode;
  /** API key scope as [resource, action] */
  scope?: [string, "create" | "read" | "update" | "delete"];
  /** Further [resource, action] scopes that also grant access (e.g. ai_agents:all for agent replies) */
  scopeAlso?: Array<[string, "create" | "read" | "update" | "delete" | "all"]>;
  /** Scope groups required in addition to `scope` (e.g. accounts:update for actions that pause accounts) */
  scopeExtra?: Array<[string, "create" | "read" | "update" | "delete"]>;
  /** Workspace member permission */
  perm?: Permission;
  /** Require a role that can write (owner/admin/editor) */
  write?: boolean;
  /** Restrict to owner/admin */
  admin?: boolean;
  /** Restrict to the workspace owner */
  owner?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyContextConfig extends RouteAuthConfig {}
}

export function ctx(req: FastifyRequest) {
  const a = req.auth;
  return {
    auth: a,
    get wsId(): string {
      if (!a.workspace) throw unauthorized("No workspace selected");
      return a.workspace.id;
    },
    get workspace(): Workspace {
      if (!a.workspace) throw unauthorized("No workspace selected");
      return a.workspace;
    },
    get user(): User {
      if (!a.user) throw unauthorized();
      return a.user;
    },
    /** User id when acting as a user, null for API keys. */
    get userId(): string | null {
      return a.user?.id ?? null;
    },
    requireRole(...roles: Role[]) {
      if (!a.role || !roles.includes(a.role)) throw forbidden();
    },
  };
}

import { integer, text } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "../../lib/ids";

export const pk = () => text("id").primaryKey().$defaultFn(uuidv7);
export const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
export const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
export const bool = (name: string) => integer(name, { mode: "boolean" });
export const workspaceId = () => text("workspace_id").notNull();

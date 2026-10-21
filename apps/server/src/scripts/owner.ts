// Shows or changes the installation owner from the machine the app runs on.
//
//   npm run owner -w @reachstack/server                    shows the owner
//   npm run owner -w @reachstack/server -- you@example.com  makes that account the owner
//
// The account must exist (sign up first). The new owner's workspaces become unlimited at once; a running server
// picks up the change within 30 seconds.
import { and, eq, isNull } from "drizzle-orm";
import { db, initDb, schema } from "../db/client";
import { getOwnerId, setOwner } from "../services/instance";

await initDb();
const email = process.argv[2]?.trim().toLowerCase();

async function describe(id: string | null) {
  if (!id) return "nobody yet (the first account to sign up becomes the owner)";
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u ? `${u.email}${u.firstName || u.lastName ? ` (${`${u.firstName} ${u.lastName}`.trim()})` : ""}` : id;
}

if (!email) {
  console.log(`Owner of this installation: ${await describe(await getOwnerId())}`);
  process.exit(0);
}

const [user] = await db
  .select()
  .from(schema.users)
  .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
  .limit(1);
if (!user) {
  console.error(`No account uses ${email}. Sign up with it first, then run this again.`);
  process.exit(1);
}
if (user.disabledAt) {
  console.error(`${email} is turned off. Turn it back on in Settings → Installation → People first.`);
  process.exit(1);
}
await setOwner(user.id);
console.log(`Done. ${await describe(user.id)} now owns this installation: full access, and their workspaces are unlimited.`);
process.exit(0);

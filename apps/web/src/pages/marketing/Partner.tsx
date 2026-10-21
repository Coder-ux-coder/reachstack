// /p/:partner — a partner's referral link. The code is kept on this device so the signup form can credit them.
import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router";
import { Flame, Inbox, Search, Send } from "lucide-react";
import { useBrand, useMe } from "@/lib/session";
import { buttonClass } from "@/components/ui";
import { CtaBand, FeatureGrid, Hero, MarketingLayout } from "./Layout";

/** Partner codes are short slugs; the signup API accepts up to 80 characters. */
const VALID = /^[\w-]{1,80}$/;

/** "jane-doe" → "Jane Doe" */
const displayName = (slug: string) =>
  slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

export default function Partner() {
  const { partner = "" } = useParams();
  const brand = useBrand();
  const me = useMe();
  const valid = VALID.test(partner);
  useEffect(() => {
    if (!valid) return;
    try {
      localStorage.setItem("rs-partner", partner);
    } catch {
      // Private browsing: the visit just goes uncredited.
    }
  }, [partner, valid]);
  if (!valid) return <Navigate to="/" replace />;
  const name = displayName(partner) || partner;
  return (
    <MarketingLayout title={`Invited by ${name}`}>
      <Hero
        eyebrow={`Recommended by ${name}`}
        title={
          <>
            {name} thinks you'll like
            <br />
            <span className="text-brand-text">{brand}</span>
          </>
        }
        body="Find the right people, warm up your mailboxes, send sequences that reach the inbox, and answer every reply from one place. Free to start, no card needed."
      >
        {me.data ? (
          <Link to="/app/dashboard" className={buttonClass("primary", "lg")}>
            Open the app
          </Link>
        ) : (
          <>
            <Link to="/auth/signup" className={buttonClass("primary", "lg")}>
              Create your free account
            </Link>
            <Link to="/auth/login" className={buttonClass("secondary", "lg")}>
              Log in
            </Link>
          </>
        )}
      </Hero>
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <FeatureGrid
          cols={4}
          items={[
            { icon: <Search size={18} />, title: "Find leads", body: "Search verified business contacts and add them to a campaign in a couple of clicks." },
            { icon: <Flame size={18} />, title: "Warm up mailboxes", body: "New accounts build a sending reputation on their own before your campaign starts." },
            { icon: <Send size={18} />, title: "Send at scale", body: "Rotate across every mailbox you connect, inside the schedule and limits you set." },
            { icon: <Inbox size={18} />, title: "One inbox", body: "Every reply from every account in one place, sorted by how interested the lead is." },
          ]}
        />
        {!me.data && <p className="mt-8 text-center text-[13px] text-muted">Sign up from this device and {name} gets the credit for the introduction.</p>}
      </section>
      <CtaBand />
    </MarketingLayout>
  );
}

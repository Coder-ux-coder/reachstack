// /mobile-app — the app on a phone: it's a web app with a manifest, so people add it to their home screen.
import { Link } from "react-router";
import { BarChart3, Inbox, Smartphone, Tags } from "lucide-react";
import { useBrand, useMe } from "@/lib/session";
import { buttonClass } from "@/components/ui";
import { CtaBand, FeatureGrid, Hero, MarketingLayout } from "./Layout";

const STEPS: Array<[string, string[]]> = [
  ["iPhone and iPad", ["Scan the code, or open the app in Safari.", "Tap the Share button at the bottom of the screen.", "Choose Add to Home Screen, then Add."]],
  ["Android", ["Scan the code, or open the app in Chrome.", "Tap the ⋮ menu in the top corner.", "Choose Add to Home screen or Install app."]],
];

export default function MobileApp() {
  const brand = useBrand();
  const me = useMe();
  return (
    <MarketingLayout title="Mobile app">
      <Hero
        eyebrow="Mobile"
        title={
          <>
            Your replies,
            <br />
            <span className="text-brand-text">wherever you are</span>
          </>
        }
        body={`${brand} runs in your phone's browser. Put it on your home screen and it opens like any other app, straight into your inbox, so you can answer replies while the conversation is fresh.`}
      >
        <Link to={me.data ? "/app/unibox" : "/auth/login?next=%2Fapp%2Funibox"} className={buttonClass("primary", "lg")}>
          {me.data ? "Open your inbox" : "Log in"}
        </Link>
      </Hero>

      <section className="mx-auto grid max-w-5xl gap-6 px-4 pb-20 sm:px-6 md:grid-cols-[minmax(0,18rem)_1fr]">
        <div className="flex flex-col items-center rounded-2xl border border-line bg-panel p-6 text-center shadow-card">
          <div className="rounded-xl bg-white p-3">
            <img src="/api/public/mobile-qr.svg" alt={`QR code that opens ${brand} on your phone`} width={184} height={184} className="h-46 w-46" />
          </div>
          <p className="mt-4 text-sm font-medium">Scan with your phone's camera</p>
          <p className="mt-1 text-xs text-muted">It opens your inbox. Log in once and you stay logged in.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {STEPS.map(([device, steps]) => (
            <div key={device} className="rounded-2xl border border-line bg-panel p-6 shadow-card">
              <div className="flex items-center gap-2">
                <Smartphone size={17} className="text-brand-text" />
                <h2 className="font-semibold">{device}</h2>
              </div>
              <ol className="mt-4 space-y-3">
                {steps.map((s, i) => (
                  <li key={s} className="flex gap-3 text-sm">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-text">{i + 1}</span>
                    <span className="pt-0.5 text-muted">{s}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-panel px-4 py-16 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <FeatureGrid
            items={[
              { icon: <Inbox size={18} />, title: "Every reply in one place", body: "Replies from all your sending accounts, in one list you can work through with your thumb." },
              { icon: <Tags size={18} />, title: "Label as you go", body: "Mark a lead as interested, booked or not a fit right from the reply." },
              { icon: <BarChart3 size={18} />, title: "Numbers on the go", body: "Check how a campaign is doing between meetings, without opening a laptop." },
            ]}
          />
        </div>
      </section>

      <CtaBand title="Not using it yet?" body={`Create a free ${brand} account on any device, then add it to your phone.`} />
    </MarketingLayout>
  );
}

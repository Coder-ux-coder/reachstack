// The public privacy center: what the Lead Finder directory holds and how people take themselves out of it, request
// a copy, make other privacy requests, and report an unwanted email (the X-Report-Abuse link that emails to people
// found through the Lead Finder carry).
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowRight, CheckCircle2, Clock, FileText, Flag, Mail, MailCheck, MessageSquare, Phone, UserX, XCircle } from "lucide-react";
import { errorMessage, post } from "@/lib/api";
import { useBrand, usePublicConfig } from "@/lib/session";
import { Button, ButtonLink, Callout, Checkbox, Field, Input, NativeSelect, Segmented, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CardPage, PrivacyHeading, PrivacyLayout, fieldErrors } from "./layout";

// ---------- Shared pieces ----------

interface Person {
  first_name: string;
  last_name: string;
  email: string;
  company_name: string;
  linkedin_url: string;
}

const emptyPerson: Person = { first_name: "", last_name: "", email: "", company_name: "", linkedin_url: "" };

/** Optional fields go out as null rather than "". */
const personBody = (p: Person) => ({ ...p, company_name: p.company_name.trim() || null, linkedin_url: p.linkedin_url.trim() || null });

function PersonFields({ value, onChange, errors, about = "self" }: { value: Person; onChange: (p: Person) => void; errors: Record<string, string>; about?: "self" | "agent" }) {
  const set = (k: keyof Person) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const their = about === "agent";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={their ? "Their first name" : "First name"} error={errors.first_name}>
        {(id) => <Input id={id} value={value.first_name} onChange={set("first_name")} autoComplete={their ? "off" : "given-name"} invalid={!!errors.first_name} required />}
      </Field>
      <Field label={their ? "Their last name" : "Last name"} error={errors.last_name}>
        {(id) => <Input id={id} value={value.last_name} onChange={set("last_name")} autoComplete={their ? "off" : "family-name"} invalid={!!errors.last_name} required />}
      </Field>
      <Field
        label={their ? "Their email address" : "Email address"}
        className="sm:col-span-2"
        error={errors.email}
        hint={their ? "The confirmation goes to this address, so the person can approve the request." : "Use the address companies contact you on. We'll send the result there."}
      >
        {(id) => <Input id={id} type="email" value={value.email} onChange={set("email")} autoComplete={their ? "off" : "email"} invalid={!!errors.email} required />}
      </Field>
      <Field label="Company" optional error={errors.company_name}>
        {(id) => <Input id={id} value={value.company_name} onChange={set("company_name")} autoComplete={their ? "off" : "organization"} />}
      </Field>
      <Field label="LinkedIn profile" optional error={errors.linkedin_url} hint={errors.linkedin_url ? undefined : "Helps us find a profile listed without this email."}>
        {(id) => <Input id={id} value={value.linkedin_url} onChange={set("linkedin_url")} placeholder="linkedin.com/in/…" invalid={!!errors.linkedin_url} inputMode="url" />}
      </Field>
    </div>
  );
}

/** A required checkbox with its error underneath. */
function Agree({ checked, onChange, error, children }: { checked: boolean; onChange: (v: boolean) => void; error?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug">
        <span className="pt-0.5">
          <Checkbox id={id} checked={checked} onChange={onChange} />
        </span>
        <span>{children}</span>
      </label>
      {error && <p className="ml-[26px] mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

function FormCard({ children, onSubmit }: { children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6 rounded-xl border border-line bg-panel p-5 shadow-card sm:p-7">
      {children}
    </form>
  );
}

type FormBody = { email: string } & Record<string, unknown>;

/** Submits a privacy form: field errors go next to their fields, anything else into a callout. */
function useSubmit(path: string, onDone: (body: FormBody) => void) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** `known` holds errors the page can tell without the server; they're shown alongside the server's. */
  const submit = async (b: FormBody, known: Record<string, string> = {}) => {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await post(path, b);
      onDone(b);
    } catch (err) {
      const fields = { ...known, ...fieldErrors(err) };
      setErrors(fields);
      setError(Object.keys(fields).length ? "Check the highlighted fields." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, errors, error, submit };
}

type Choice = "access" | "delete" | "opt_out" | "correct" | "other";
interface Outcome {
  type: "opt_out" | "data_request" | "removal";
  status: "pending" | "verified" | "resolved" | "rejected";
  done: Choice[];
  waiting: Choice[];
}

/** Confirms the request behind an emailed link once (links are single-use, and dev mode runs effects twice). */
function useConfirmLink(token: string | null) {
  const [state, setState] = useState<{ status: "idle" | "working" | "done" | "error"; outcome?: Outcome; error?: string }>({ status: token ? "working" : "idle" });
  const ran = useRef<string | null>(null);
  useEffect(() => {
    if (!token || ran.current === token) return;
    ran.current = token;
    setState({ status: "working" });
    // A slow answer for an earlier link must not replace the current one.
    post<Outcome>("/api/public/privacy/confirm", { token })
      .then((outcome) => ran.current === token && setState({ status: "done", outcome }))
      .catch((err) => ran.current === token && setState({ status: "error", error: errorMessage(err) }));
  }, [token]);
  return state;
}

function StatusIcon({ tone, children }: { tone: "ok" | "brand" | "bad"; children: ReactNode }) {
  return <div className={cn("mx-auto mb-5 w-fit rounded-2xl p-3.5", tone === "ok" ? "bg-ok-soft text-ok" : tone === "bad" ? "bg-bad-soft text-bad" : "bg-brand-soft text-brand-text")}>{children}</div>;
}

/** A centered result inside the privacy center. */
function Result({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-auto max-w-lg py-6 text-center">
      {icon}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children && <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-muted">{children}</div>}
      {actions && <div className="mt-7 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

function CheckInbox({ email, children }: { email?: string | null; children?: ReactNode }) {
  return (
    <Result
      icon={
        <StatusIcon tone="brand">
          <MailCheck size={30} strokeWidth={1.6} />
        </StatusIcon>
      }
      title="Check your inbox"
    >
      <p>
        We sent a confirmation link to {email ? <b className="text-text">{email}</b> : "the address you entered"}. Open it within 7 days to go ahead.
      </p>
      {children}
      <p className="text-[13px]">Nothing there? Look in your spam folder, or send the form again.</p>
    </Result>
  );
}

function LinkFailed({ error, retry }: { error?: string; retry: string }) {
  return (
    <Result
      icon={
        <StatusIcon tone="bad">
          <XCircle size={30} strokeWidth={1.6} />
        </StatusIcon>
      }
      title="This link doesn't work anymore"
      actions={
        <ButtonLink to={retry} variant="primary">
          Send the form again
        </ButtonLink>
      }
    >
      <p>{error ?? "It may have expired or already been used."}</p>
    </Result>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
      <Spinner size={22} />
      {label}
    </div>
  );
}

function ContactLine({ prefix }: { prefix: string }) {
  const privacy = usePublicConfig().data?.privacy;
  if (!privacy?.email && !privacy?.phone) return null;
  return (
    <p className="text-[13px] text-muted">
      {prefix}{" "}
      {privacy.email && (
        <a href={`mailto:${privacy.email}`} className="font-medium text-brand-text hover:underline">
          {privacy.email}
        </a>
      )}
      {privacy.email && privacy.phone && " or call "}
      {privacy.phone && (
        <a href={`tel:${privacy.phone.replace(/[^\d+]/g, "")}`} className="font-medium text-brand-text hover:underline">
          {privacy.phone}
        </a>
      )}
      .
    </p>
  );
}

// ---------- /privacy/info ----------

export function PrivacyInfo() {
  const brand = useBrand();
  const privacy = usePublicConfig().data?.privacy;
  const actions = [
    { to: "/privacy/opt-out", icon: <UserX size={20} />, title: "Remove your profile", body: "Take your profile out of the directory and keep it out. It happens as soon as you send the form." },
    { to: "/privacy/data-request", icon: <FileText size={20} />, title: "Get a copy of your data", body: "We email you what the directory holds about you, where it came from and how often it was looked up." },
    { to: "/privacy/report-abuse", icon: <Flag size={20} />, title: "Report an unwanted email", body: `Got an unwanted email with a ${brand} report link? Use it and no campaign here can email you again.` },
    { to: "/privacy/manager", icon: <MessageSquare size={20} />, title: "Something else?", body: "Correct your details, delete them, ask a question, or make a request for someone else." },
  ];
  return (
    <PrivacyLayout title="Privacy center">
      <PrivacyHeading eyebrow="Privacy center" title="Your data, your choice">
        <p>
          {brand} is software that companies use to find business contacts and email them. Its Lead Finder search includes a directory of work profiles: a name, job title and
          company, and sometimes a work email, phone number or LinkedIn link.
        </p>
        <p>If you're in it, you decide what happens next. None of the options below needs an account.</p>
      </PrivacyHeading>

      <div className="grid gap-3 sm:grid-cols-2">
        {actions.map((a) => (
          <Link key={a.to} to={a.to} className="group flex flex-col rounded-xl border border-line bg-panel p-5 shadow-card transition-colors hover:border-brand/50">
            <div className="mb-3 w-fit rounded-lg bg-brand-soft p-2 text-brand-text">{a.icon}</div>
            <h2 className="flex items-center gap-1.5 font-semibold">
              {a.title}
              <ArrowRight size={15} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand-text" />
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{a.body}</p>
          </Link>
        ))}
      </div>

      <h2 className="mb-3 mt-12 text-lg font-semibold tracking-tight">Good to know</h2>
      <dl className="divide-y divide-line rounded-xl border border-line bg-panel">
        {[
          [
            "Companies keep their own lists",
            `Once a company adds you to its own list, that copy is theirs. Removing your profile here stops new companies finding you through ${brand}. To leave a company's list, use the unsubscribe link in its email or ask it directly.`,
          ],
          [
            "Stopping a sender",
            `Use the unsubscribe link in the email, or reply and ask the sender to stop. If they found you in this directory, the email also carries a link to report it to ${brand}.`,
          ],
          [
            "What we keep after an opt-out",
            "Your email address, and your LinkedIn link if you gave one, go on a do-not-add list so the next data import leaves you out. We also keep a record of the request itself.",
          ],
          ["Answers go to you only", "Requests for your data are confirmed through the email address in the request, so a copy only ever reaches its owner."],
        ].map(([q, a]) => (
          <div key={q} className="px-5 py-4">
            <dt className="text-sm font-medium">{q}</dt>
            <dd className="mt-1 text-[13px] leading-relaxed text-muted">{a}</dd>
          </div>
        ))}
      </dl>

      {(privacy?.email || privacy?.phone) && (
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span className="font-medium">Talk to us</span>
          {privacy.email && (
            <a href={`mailto:${privacy.email}`} className="flex items-center gap-1.5 text-brand-text hover:underline">
              <Mail size={14} /> {privacy.email}
            </a>
          )}
          {privacy.phone && (
            <a href={`tel:${privacy.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 text-brand-text hover:underline">
              <Phone size={14} /> {privacy.phone}
            </a>
          )}
        </div>
      )}
    </PrivacyLayout>
  );
}

// ---------- /privacy/opt-out ----------

export function OptOut() {
  const brand = useBrand();
  const nav = useNavigate();
  const [person, setPerson] = useState(emptyPerson);
  const [identity, setIdentity] = useState(false);
  const [retention, setRetention] = useState(false);
  const form = useSubmit("/api/public/privacy/opt-out", (b) => nav("/privacy/opt-out/confirm", { state: { email: b.email } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    form.submit({ ...personBody(person), confirm_identity: identity, confirm_retention: retention });
  };
  return (
    <PrivacyLayout title="Remove your profile">
      <PrivacyHeading eyebrow="Opt out" title="Remove your profile">
        <p>Tell us who you are and we'll delete your profile from the Lead Finder directory, then keep it from coming back. The result goes to the email address you enter.</p>
      </PrivacyHeading>
      <FormCard onSubmit={submit}>
        {form.error && <Callout tone="bad">{form.error}</Callout>}
        <PersonFields value={person} onChange={setPerson} errors={form.errors} />
        <div className="space-y-3 border-t border-line pt-5">
          <Agree checked={identity} onChange={setIdentity} error={form.errors.confirm_identity}>
            I'm the person named above, or I'm allowed to act for them.
          </Agree>
          <Agree checked={retention} onChange={setRetention} error={form.errors.confirm_retention}>
            I understand {brand} keeps my email address on its do-not-add list, only to keep me out.
          </Agree>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">
            Want to see your data first?{" "}
            <Link to="/privacy/data-request" className="font-medium text-brand-text hover:underline">
              Get a copy
            </Link>
          </p>
          <Button type="submit" variant="primary" size="lg" loading={form.busy}>
            Remove my profile
          </Button>
        </div>
      </FormCard>
    </PrivacyLayout>
  );
}

/** /privacy/opt-out/confirm — where the form lands. Opt-outs need no confirmation, but a request link still works here. */
export function OptOutDone() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const email = (useLocation().state as { email?: string } | null)?.email;
  const link = useConfirmLink(token);
  if (token)
    return (
      <PrivacyLayout title="Your request">
        <ConfirmedRequest link={link} retry="/privacy/opt-out" />
      </PrivacyLayout>
    );
  return (
    <PrivacyLayout title="You're opted out">
      <Result
        icon={
          <StatusIcon tone="ok">
            <CheckCircle2 size={30} strokeWidth={1.6} />
          </StatusIcon>
        }
        title="You're opted out"
        actions={
          <ButtonLink to="/privacy/info" variant="secondary">
            Back to the privacy center
          </ButtonLink>
        }
      >
        <p>
          {email ? (
            <>
              <b className="text-text">{email}</b> is on our do-not-add list.
            </>
          ) : (
            "Your address is on our do-not-add list."
          )}{" "}
          Any profile we held for it is gone, and we've emailed you what we found.
        </p>
        <p className="text-[13px]">Companies that already added you to their own lists keep their copy. To leave one, use the unsubscribe link in its email or ask it directly.</p>
      </Result>
    </PrivacyLayout>
  );
}

// ---------- /privacy/data-request ----------

export function DataRequest() {
  const brand = useBrand();
  const nav = useNavigate();
  const [person, setPerson] = useState(emptyPerson);
  const [identity, setIdentity] = useState(false);
  const [verification, setVerification] = useState(false);
  const form = useSubmit("/api/public/privacy/data-request", (b) => nav("/privacy/data-request/confirm", { state: { email: b.email } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    form.submit({ ...personBody(person), confirm_identity: identity, confirm_verification: verification });
  };
  return (
    <PrivacyLayout title="Get a copy of your data">
      <PrivacyHeading eyebrow="Access" title="Get a copy of your data">
        <p>We'll email you everything the Lead Finder directory holds about you: your profile, where it came from, and how many companies have looked it up.</p>
        <p>So that only you see it, we first send a link to confirm the address.</p>
      </PrivacyHeading>
      <FormCard onSubmit={submit}>
        {form.error && <Callout tone="bad">{form.error}</Callout>}
        <PersonFields value={person} onChange={setPerson} errors={form.errors} />
        <div className="space-y-3 border-t border-line pt-5">
          <Agree checked={identity} onChange={setIdentity} error={form.errors.confirm_identity}>
            I'm the person named above, or I'm allowed to act for them.
          </Agree>
          <Agree checked={verification} onChange={setVerification} error={form.errors.confirm_verification}>
            {brand} may use these details to confirm who I am and to look for my data.
          </Agree>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="lg" loading={form.busy}>
            Send me my data
          </Button>
        </div>
      </FormCard>
    </PrivacyLayout>
  );
}

/** /privacy/data-request/confirm — "check your inbox" after the form, or (with ?token=) the emailed link. */
export function DataRequestConfirm() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const email = (useLocation().state as { email?: string } | null)?.email;
  const link = useConfirmLink(token);
  return (
    <PrivacyLayout title={token ? "Your data report" : "Check your inbox"}>
      {token ? (
        <ConfirmedRequest link={link} retry="/privacy/data-request" />
      ) : (
        <CheckInbox email={email}>
          <p>Your report goes out as soon as you do.</p>
        </CheckInbox>
      )}
    </PrivacyLayout>
  );
}

// ---------- The confirmed request (any emailed link) ----------

// Whether a profile existed only goes out by email, so these hold either way.
const DONE_TEXT: Record<Choice, string> = {
  access: "We emailed you a copy of the data we hold about you.",
  delete: "We deleted any profile we held for you, and your address is on our do-not-add list.",
  opt_out: "We stopped using and sharing your data, and your address is on our do-not-add list.",
  correct: "",
  other: "",
};

const WAITING_TEXT: Partial<Record<Choice, string>> = {
  correct: "Correcting your data. Someone will look at what you sent and reply by email.",
  other: "Your question. Someone will reply by email.",
};

function ConfirmedRequest({ link, retry }: { link: ReturnType<typeof useConfirmLink>; retry: string }) {
  if (link.status === "working" || link.status === "idle") return <Working label="Confirming your request…" />;
  if (link.status === "error" || !link.outcome) return <LinkFailed error={link.error} retry={retry} />;
  const { outcome } = link;
  const back = (
    <ButtonLink to="/privacy/info" variant="secondary">
      Back to the privacy center
    </ButtonLink>
  );
  if (!outcome.done.length && !outcome.waiting.length)
    return (
      <Result
        icon={
          <StatusIcon tone="brand">
            <CheckCircle2 size={30} strokeWidth={1.6} />
          </StatusIcon>
        }
        title="This request is already closed"
        actions={back}
      >
        <p>{outcome.status === "rejected" ? "It was closed without action. If you still need something, send a new request." : "It was handled before you opened the link. There's nothing more to do."}</p>
      </Result>
    );
  const onlyReport = outcome.done.length === 1 && outcome.done[0] === "access" && !outcome.waiting.length;
  return (
    <Result
      icon={
        <StatusIcon tone="ok">
          <CheckCircle2 size={30} strokeWidth={1.6} />
        </StatusIcon>
      }
      title={onlyReport ? "Your report is on its way" : "Request confirmed"}
      actions={back}
    >
      {onlyReport ? (
        <p>We've emailed your data report to the address you gave us. It should arrive in a minute or two.</p>
      ) : (
        <ul className="mx-auto mt-2 max-w-md space-y-2.5 text-left text-sm">
          {/* Deleting covers stopping, and both say the same thing. */}
          {outcome.done
            .filter((c) => !(c === "opt_out" && outcome.done.includes("delete")))
            .map((c) => (
              <li key={c} className="flex gap-2.5">
                <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-ok" />
                <span className="text-text">{DONE_TEXT[c]}</span>
              </li>
            ))}
          {outcome.waiting.map((c) => (
            <li key={c} className="flex gap-2.5">
              <Clock size={17} className="mt-0.5 shrink-0 text-warn" />
              <span className="text-text">{WAITING_TEXT[c]}</span>
            </li>
          ))}
        </ul>
      )}
    </Result>
  );
}

// ---------- /privacy/manager ----------

const REQUESTS: Array<{ value: Choice; label: string; hint: string }> = [
  { value: "access", label: "Send me a copy of my data", hint: "Everything the directory holds about you, by email." },
  { value: "delete", label: "Delete my data", hint: "Your profile is removed and kept out." },
  { value: "opt_out", label: "Stop using or sharing my data", hint: "Nobody can find or reveal your profile anymore." },
  { value: "correct", label: "Correct my data", hint: "Tell us what's wrong below." },
  { value: "other", label: "Something else", hint: "Ask us anything about your data." },
];

// Region codes that aren't countries.
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "ZZ", "XA", "XB"]);

function useCountries() {
  return useMemo(() => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const out: Array<{ value: string; label: string }> = [];
    const seen = new Set<string>();
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        if (NOT_COUNTRIES.has(code)) continue;
        let name: string | undefined;
        try {
          name = names.of(code);
        } catch {
          name = undefined;
        }
        // Unknown codes come back unchanged, and retired codes repeat a current name (DD and DE are both Germany).
        if (name && name !== code && !seen.has(name)) {
          seen.add(name);
          out.push({ value: name, label: name });
        }
      }
    return out.sort((x, y) => x.label.localeCompare(y.label));
  }, []);
}

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois",
  "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "Puerto Rico", "Guam", "U.S. Virgin Islands",
  "American Samoa", "Northern Mariana Islands",
];

export function PrivacyManager() {
  const brand = useBrand();
  const [params] = useSearchParams();
  const token = params.get("token");
  const link = useConfirmLink(token);
  const countries = useCountries();
  const [applicant, setApplicant] = useState<"self" | "agent">("self");
  const [person, setPerson] = useState(emptyPerson);
  const [country, setCountry] = useState("");
  const [state, setState] = useState("");
  const [requests, setRequests] = useState<Choice[]>([]);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [website, setWebsite] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const formId = useId();
  const form = useSubmit("/api/public/privacy/requests", (b) => {
    setSentTo(b.email);
    window.scrollTo({ top: 0 });
  });
  const isUS = country === "United States";
  const needsMessage = requests.includes("correct") || requests.includes("other");
  const toggle = (c: Choice, on: boolean) => setRequests((r) => (on ? [...r, c] : r.filter((x) => x !== c)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...personBody(person), applicant_type: applicant, country, state: isUS && state ? state : null, requests, message: message.trim() || null, confirm, website };
    form.submit(body, needsMessage && !body.message ? { message: "Tell us what to correct or what you need" } : {});
  };

  if (token)
    return (
      <PrivacyLayout title="Your privacy request">
        <ConfirmedRequest link={link} retry="/privacy/manager" />
      </PrivacyLayout>
    );
  if (sentTo)
    return (
      <PrivacyLayout title="Check your inbox">
        <CheckInbox email={sentTo}>
          <p>{applicant === "agent" ? "The person it's about needs to open it: that's how we know they agreed." : "Your request starts once you do."}</p>
        </CheckInbox>
      </PrivacyLayout>
    );

  return (
    <PrivacyLayout title="Make a privacy request">
      <PrivacyHeading eyebrow="Privacy request" title="Make a privacy request">
        <p>Use this form for anything about personal data on {brand}: a copy, a correction, a deletion, or a question. We confirm the email address first, then get to work.</p>
      </PrivacyHeading>
      <FormCard onSubmit={submit}>
        {form.error && <Callout tone="bad">{form.error}</Callout>}
        <Field label="Who is the request for?" error={form.errors.applicant_type}>
          <Segmented
            value={applicant}
            onChange={setApplicant}
            options={[
              { value: "self", label: "Me" },
              { value: "agent", label: "Someone I represent" },
            ]}
          />
        </Field>
        <PersonFields value={person} onChange={setPerson} errors={form.errors} about={applicant} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" error={form.errors.country}>
            {(id) => (
              <NativeSelect
                id={id}
                value={country}
                onChange={(v) => {
                  setCountry(v);
                  if (v !== "United States") setState("");
                }}
                options={[{ value: "", label: "Choose a country" }, ...countries]}
              />
            )}
          </Field>
          {isUS && (
            <Field label="State" optional error={form.errors.state}>
              {(id) => <NativeSelect id={id} value={state} onChange={setState} options={[{ value: "", label: "Choose a state" }, ...US_STATES.map((s) => ({ value: s, label: s }))]} />}
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">What should we do?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {REQUESTS.map((r) => {
              const on = requests.includes(r.value);
              return (
                <label
                  key={r.value}
                  htmlFor={`${formId}-${r.value}`}
                  className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors", on ? "border-brand/60 bg-brand-soft/40" : "border-line hover:bg-panel-2")}
                >
                  <span className="pt-0.5">
                    <Checkbox id={`${formId}-${r.value}`} checked={on} onChange={(v) => toggle(r.value, v)} />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-xs text-muted">{r.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {form.errors.requests && <p className="mt-1.5 text-xs text-bad">{form.errors.requests}</p>}
        </fieldset>
        <Field label="Details" optional={!needsMessage} error={form.errors.message} hint={needsMessage ? "Tell us what to correct, or what you need." : "Anything that helps us find you or understand the request."}>
          {(id) => <Textarea id={id} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} invalid={!!form.errors.message} />}
        </Field>
        {/* Left empty by people; bots fill every field. */}
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
          </label>
        </div>
        <div className="border-t border-line pt-5">
          <Agree checked={confirm} onChange={setConfirm} error={form.errors.confirm}>
            The details above are accurate, and I'm the person named or allowed to act for them.
          </Agree>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ContactLine prefix="Prefer to write? Email" />
          <Button type="submit" variant="primary" size="lg" loading={form.busy} className="ml-auto">
            Send request
          </Button>
        </div>
      </FormCard>
    </PrivacyLayout>
  );
}

// ---------- /privacy/report-abuse ----------

/** The report ID from a pasted link (…/privacy/report-abuse/<id>) or the bare ID. */
function reportId(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const m = v.match(/report-abuse\/([^/?#\s]+)/);
  let id = v;
  try {
    if (m) id = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return /^[\w.-]{8,200}$/.test(id) ? id : null;
}

export function ReportAbuseStart() {
  const brand = useBrand();
  const nav = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = (e: FormEvent) => {
    e.preventDefault();
    const id = reportId(value);
    if (!id) return setError("Paste the whole link from the X-Report-Abuse line.");
    nav(`/privacy/report-abuse/${encodeURIComponent(id)}`);
  };
  return (
    <PrivacyLayout title="Report an unwanted email">
      <PrivacyHeading eyebrow="Report abuse" title="Report an unwanted email">
        <p>
          When someone uses {brand} to email a person they found in its Lead Finder directory, the email carries its own report link. Use it and no campaign here will email
          you again, and the people behind the sending account are told.
        </p>
      </PrivacyHeading>
      <div className="space-y-6 rounded-xl border border-line bg-panel p-5 shadow-card sm:p-7">
        <div>
          <h2 className="font-semibold">Find the report link</h2>
          <ol className="mt-3 space-y-3 text-sm">
            {[
              "Open the email you want to report.",
              <>
                Show the full message source. In Gmail, open the <b>⋮</b> menu next to Reply and choose <b>Show original</b>. In Outlook on the web, open <b>…</b> then{" "}
                <b>View</b> → <b>View message source</b>.
              </>,
              <>
                Find the line that starts with <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[12px]">X-Report-Abuse:</code> and open the link in it, or paste it below.
              </>,
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-text">{i + 1}</span>
                <span className="pt-0.5 leading-relaxed text-muted">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <form onSubmit={go} className="border-t border-line pt-5">
          <Field label="Report link" error={error}>
            {(id) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={id}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setError(null);
                  }}
                  placeholder={`${window.location.origin}/privacy/report-abuse/…`}
                  invalid={!!error}
                  className="flex-1"
                />
                <Button type="submit" variant="primary">
                  Continue
                </Button>
              </div>
            )}
          </Field>
        </form>
      </div>
      <p className="mt-6 text-[13px] text-muted">
        No such line? Then the sender didn't find you through {brand}: use their unsubscribe link or ask them to stop. Either way, you can still{" "}
        <Link to="/privacy/opt-out" className="font-medium text-brand-text hover:underline">
          remove your profile
        </Link>{" "}
        so nobody finds you here.
      </p>
    </PrivacyLayout>
  );
}

/** /privacy/report-abuse/:id — the link in a sent email's X-Report-Abuse header. */
export function ReportAbuse() {
  const brand = useBrand();
  const { id = "" } = useParams();
  const [status, setStatus] = useState<"checking" | "valid" | "reported" | "already" | "invalid" | "error">("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setStatus("checking");
    post<{ status: "valid" | "reported" | "invalid" }>("/api/public/abuse/verify", { id })
      .then((r) => live && setStatus(r.status === "reported" ? "already" : r.status))
      .catch((err) => {
        if (!live) return;
        setError(errorMessage(err));
        setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [id]);

  const report = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ status: "reported" | "already" }>("/api/public/abuse/submit", { id });
      setStatus(r.status);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (status === "checking")
    return (
      <CardPage title="Report an email">
        <Working label="Looking up this email…" />
      </CardPage>
    );
  if (status === "reported" || status === "already")
    return (
      <CardPage title="Thanks for reporting">
        <StatusIcon tone="ok">
          <CheckCircle2 size={30} strokeWidth={1.6} />
        </StatusIcon>
        <h1 className="text-xl font-semibold">{status === "reported" ? "Thanks, we've got your report" : "This email was already reported"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">No campaign on {brand} will email this address again, and the sender has been told.</p>
        <Link to="/privacy/info" className="mt-6 inline-block text-[13px] font-medium text-brand-text hover:underline">
          More privacy options
        </Link>
      </CardPage>
    );
  if (status === "invalid" || status === "error")
    return (
      <CardPage title="Report an email">
        <StatusIcon tone="bad">
          <XCircle size={30} strokeWidth={1.6} />
        </StatusIcon>
        <h1 className="text-xl font-semibold">{status === "invalid" ? "We can't find this email" : "Something went wrong"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{status === "invalid" ? "The link may be cut short. Copy the whole link from the X-Report-Abuse line and try again." : error}</p>
        <ButtonLink to="/privacy/report-abuse" variant="secondary" className="mt-6">
          Try again
        </ButtonLink>
      </CardPage>
    );
  return (
    <CardPage title="Report an email">
      <StatusIcon tone="bad">
        <Flag size={28} strokeWidth={1.6} />
      </StatusIcon>
      <h1 className="text-xl font-semibold">Report this email as unwanted?</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        You'll be unsubscribed, no campaign on {brand} will email you again, and the people behind the sending account will be told.
      </p>
      {error && (
        <Callout tone="bad" className="mt-4 text-left">
          {error}
        </Callout>
      )}
      <div className="mt-6 flex flex-col gap-2">
        <Button variant="danger" size="lg" loading={busy} onClick={report}>
          Report this email
        </Button>
        <ButtonLink to="/privacy/info" variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </CardPage>
  );
}

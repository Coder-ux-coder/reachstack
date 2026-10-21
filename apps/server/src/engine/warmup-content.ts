// Natural-looking warmup email copy, assembled from fragments so messages rarely repeat.

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

const SUBJECTS = [
  "Quick question about {topic}",
  "Following up on {topic}",
  "Thoughts on {topic}?",
  "{topic} next week",
  "Notes from our call",
  "Re-scheduling {day}",
  "Can we sync on {topic}?",
  "Small update on {topic}",
  "Draft for your review",
  "Idea for {topic}",
  "Checking in",
  "Agenda for {day}",
  "Feedback on the {topic} plan",
  "One more thing about {topic}",
  "Coffee {day}?",
  "Summary of {topic}",
  "{topic}: next steps",
  "Your input on {topic}",
] as const;

const TOPICS = [
  "the Q3 roadmap",
  "the onboarding flow",
  "the vendor shortlist",
  "the budget review",
  "our hiring plan",
  "the client workshop",
  "the newsletter",
  "the partner program",
  "pricing changes",
  "the product launch",
  "the team offsite",
  "the website refresh",
  "the support backlog",
  "quarterly goals",
  "the analytics dashboard",
  "the contract renewal",
  "the training session",
  "the research interviews",
] as const;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "next week", "tomorrow"] as const;

const OPENERS = [
  "Hi {name},",
  "Hey {name},",
  "Hello {name},",
  "Good morning {name},",
  "{name},",
  "Hi there {name},",
] as const;

const BODIES = [
  "I went through the notes on {topic} and I think we're close. The main open point is timing, so it would help to hear what works on your side.",
  "Hope your week is going well. I wanted to check whether you had a chance to look at {topic}. No rush, just keen to keep it moving.",
  "Quick one: are you still planning to share the numbers for {topic} before {day}? I'd like to add them to the summary.",
  "I put together a short outline for {topic}. It covers the goals, a rough timeline and who owns what. Let me know if anything looks off.",
  "Thanks again for the help earlier. I've updated the doc for {topic} with your comments and flagged two questions at the end.",
  "Would {day} work for a short call about {topic}? Thirty minutes should be enough to agree on the next steps.",
  "I was thinking more about {topic} and wondered if we should involve the wider team earlier this time. Curious what you think.",
  "Just a heads-up that I moved our meeting about {topic} to {day}. Same link as before.",
  "Sharing a quick recap of {topic}: we agreed on the scope, the owners are confirmed, and the first milestone is {day}.",
  "Do you have the latest version of the file for {topic}? The one I have seems to be missing the last round of edits.",
  "I really liked your suggestion on {topic}. I tried it this morning and it already saves a lot of back and forth.",
  "Could you take a look at the draft for {topic} when you get a moment? I'd value a second pair of eyes before it goes out.",
] as const;

const CLOSERS = [
  "Thanks,",
  "Best,",
  "Cheers,",
  "Talk soon,",
  "Many thanks,",
  "Kind regards,",
  "Speak soon,",
] as const;

const REPLIES = [
  "Thanks for the note, that works for me. I'll follow up with the details shortly.",
  "Sounds good. {day} is fine on my side.",
  "Appreciate the update. I'll take a look today and get back to you.",
  "Great, thanks for pulling this together. Looks good to me.",
  "Yes, let's do that. I'll send a calendar invite.",
  "Thanks! I added a couple of comments, mostly small wording changes.",
  "Perfect, that answers my question. Thanks for the quick reply.",
  "Got it, I'll share the numbers before {day}.",
  "Makes sense. Let's keep it as planned and revisit after the first milestone.",
  "Thank you, really helpful. I'll loop in the team.",
] as const;

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? "");
}

export interface WarmupCopy {
  subject: string;
  text: string;
  html: string;
}

export function warmupEmail(opts: { recipientFirstName: string; senderFirstName: string; tag: string; custom?: { subjects: string[]; bodies: string[] } | null; link?: string | null }): WarmupCopy {
  const vars = { name: opts.recipientFirstName || "there", topic: pick(TOPICS), day: pick(DAYS) };
  const useCustom = !!opts.custom && opts.custom.subjects.length > 0 && opts.custom.bodies.length > 0;
  const subject = fill(useCustom ? pick(opts.custom!.subjects) : pick(SUBJECTS), vars);
  const body = fill(useCustom ? pick(opts.custom!.bodies) : pick(BODIES), vars);
  const lines = [fill(pick(OPENERS), vars), "", body];
  if (opts.link) lines.push("", `More context here: ${opts.link}`);
  lines.push("", pick(CLOSERS), opts.senderFirstName || "", "", opts.tag);
  const text = lines.join("\n").trim();
  const html = lines.map((l) => (l ? `<div>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>` : "<div><br/></div>")).join("");
  return { subject: `${subject} | ${opts.tag}`, text, html };
}

export function warmupReply(opts: { recipientFirstName: string; senderFirstName: string; tag: string }): { text: string; html: string } {
  const vars = { name: opts.recipientFirstName || "there", topic: pick(TOPICS), day: pick(DAYS) };
  const lines = [fill(pick(OPENERS), vars), "", fill(pick(REPLIES), vars), "", pick(CLOSERS), opts.senderFirstName || "", "", opts.tag];
  const text = lines.join("\n").trim();
  const html = lines.map((l) => (l ? `<div>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>` : "<div><br/></div>")).join("");
  return { text, html };
}

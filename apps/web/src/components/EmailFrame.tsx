import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Shows email HTML (from leads, templates or campaigns) in a sandboxed iframe: no scripts, no forms,
 * links open in a new tab, and a CSP that only allows inline styles and, optionally, images.
 * The frame grows with its content.
 */
export function EmailFrame({ html, className, blockImages = false, minHeight = 120 }: { html: string; className?: string; blockImages?: boolean; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${blockImages ? "data: cid:" : "https: http: data: cid:"}; font-src data:;`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:transparent;}
    body{display:flow-root;overflow:hidden;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:${dark ? "#e4e4e7" : "#18181b"};word-wrap:break-word;overflow-wrap:anywhere;}
    a{color:${dark ? "#a5b4fc" : "#4f46e5"};}
    p{margin:0 0 .75em;} blockquote{margin:.5em 0;padding-left:.75em;border-left:3px solid ${dark ? "#3f3f46" : "#e4e4e7"};color:${dark ? "#a1a1aa" : "#52525b"};}
    img{max-width:100%;height:auto;} pre{white-space:pre-wrap;}
  </style></head><body>${html}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    let frameId = 0;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.max(minHeight, Math.min(body.scrollHeight + 8, 4000)));
    };
    // Resizing the frame from inside the observer's callback can resize the body again in the same frame, which
    // browsers report as "ResizeObserver loop completed with undelivered notifications". Measure on the next frame.
    const measureSoon = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };
    const attach = () => {
      const body = frame.contentDocument?.body;
      // A new frame starts on an empty about:blank page that is replaced moments later; measure only the email itself.
      if (!body || frame.contentDocument?.URL !== "about:srcdoc") return;
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measureSoon);
      observer.observe(body);
    };
    frame.addEventListener("load", attach);
    attach();
    return () => {
      frame.removeEventListener("load", attach);
      observer?.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [doc, minHeight]);

  return (
    <iframe
      // A fresh frame per email, so the about:srcdoc check above never sees the previous email's document.
      key={doc}
      ref={ref}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      className={cn("w-full border-0", className)}
      style={{ height }}
    />
  );
}

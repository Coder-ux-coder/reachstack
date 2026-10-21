import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** For a box that scrolls sideways: a style that fades out the edge with more to scroll to, so it's plain there's
 *  more than fits (wide tables and tab strips on a phone). */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The box keeps its width when rows load or tabs change; the content's size is what moves.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  const edge = (fade: boolean) => (fade ? "transparent" : "#000");
  const mask = more.left || more.right ? `linear-gradient(to right, ${edge(more.left)}, #000 1.75rem, #000 calc(100% - 1.75rem), ${edge(more.right)})` : undefined;
  const style: CSSProperties | undefined = mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined;
  return [ref, style] as const;
}

/** Scrolls a sideways box just far enough to show this child clear of the fade (the open tab on a phone). Only
 *  sideways: the page itself doesn't move. */
export function revealSideways(box: HTMLElement | null, child: Element | null | undefined) {
  if (!box || !child) return;
  const b = box.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  const room = 28;
  if (c.left < b.left + room) box.scrollLeft -= b.left + room - c.left;
  else if (c.right > b.right - room) box.scrollLeft += c.right - (b.right - room);
}

/** A box that scrolls sideways, with the fade. */
export function ScrollX({ children, className }: { children: ReactNode; className?: string }) {
  const [ref, style] = useScrollFade<HTMLDivElement>();
  return (
    <div ref={ref} className={cn("scroll-thin overflow-x-auto", className)} style={style}>
      {children}
    </div>
  );
}

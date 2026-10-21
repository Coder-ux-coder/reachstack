export type Theme = "light" | "dark" | "system";

let media: MediaQueryList | null = null;
let current: Theme = "system";

function paint() {
  const dark = current === "dark" || (current === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function applyTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem("rs-theme", theme);
  } catch {
    // storage unavailable (private mode)
  }
  if (!media) {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => current === "system" && paint());
  }
  paint();
}

export function savedTheme(): Theme {
  try {
    return (localStorage.getItem("rs-theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

/** An agency's white-label colour in place of the product colour; null restores the stylesheet's. */
/** Text colour for a fill: white, unless dark text reads better on it (a light brand colour). */
export function textOn(color: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color?.trim() ?? "");
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / 0.058; // the text colour, #15161c
  return onWhite >= 4.5 || onWhite >= onDark ? "#ffffff" : "#15161c";
}

export function applyBrandColor(color: string | null) {
  const style = document.documentElement.style;
  if (!color) {
    for (const v of ["--brand", "--brand-hover", "--brand-soft", "--brand-text", "--on-brand"]) style.removeProperty(v);
    return;
  }
  style.setProperty("--brand", color);
  style.setProperty("--on-brand", textOn(color));
  style.setProperty("--brand-hover", `color-mix(in srgb, ${color} 85%, black)`);
  style.setProperty("--brand-soft", `color-mix(in srgb, ${color} 14%, transparent)`);
  style.setProperty("--brand-text", `color-mix(in srgb, ${color} 75%, var(--text))`);
}

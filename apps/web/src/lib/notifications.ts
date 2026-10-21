// Browser notifications for what lands under the bell (components/shell/NotificationBell.tsx). Opt-in on each browser,
// and only while the app is open in a tab: nothing is pushed when every tab is closed.
import { useSyncExternalStore } from "react";

const KEY = "rs-browser-notifications";
const listeners = new Set<() => void>();

export type BrowserPermission = NotificationPermission | "unsupported";

const supported = () => typeof window !== "undefined" && "Notification" in window;
const permission = (): BrowserPermission => (supported() ? Notification.permission : "unsupported");

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

function store(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable (private mode): the choice lasts until the page reloads
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Other tabs, and coming back after allowing or blocking notifications in the browser's settings.
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", listener);
  };
}

const snapshot = () => `${stored() ? "on" : "off"}|${permission()}`;

export function useBrowserNotifications() {
  const [choice, perm] = useSyncExternalStore(subscribe, snapshot, () => "off|unsupported").split("|") as ["on" | "off", BrowserPermission];
  /** Turning on asks the browser for permission first. Returns the browser's answer ("granted" means it's on). */
  const setEnabled = async (on: boolean): Promise<BrowserPermission> => {
    if (!on) {
      store(false);
      return permission();
    }
    if (!supported()) return "unsupported";
    const answer = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    store(answer === "granted");
    return answer;
  };
  return { permission: perm, enabled: choice === "on" && perm === "granted", setEnabled };
}

/** Shows one, unless this browser is set not to. Clicking it brings the tab forward and runs `onClick`. */
export function showBrowserNotification(n: { id: string; title: string; body?: string | null }, onClick: () => void) {
  if (!supported() || Notification.permission !== "granted" || !stored()) return;
  try {
    // The tag stops two open tabs from showing the same one twice.
    const shown = new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
    shown.onclick = () => {
      window.focus();
      onClick();
      shown.close();
    };
  } catch {
    // Some mobile browsers only show notifications from a service worker; the bell still has it.
  }
}

// The website visitor snippet served at /wv.js. Plain ES5 so it runs on any site. It sends a pageview per page
// (single-page app navigations included) and the visible time spent on it, and stays silent when the browser
// asks not to be tracked (Do Not Track or Global Privacy Control). No cookies: a random id in localStorage
// groups a browser's pageviews into visits.
export const VISITOR_SCRIPT = `(function () {
  var d = document, w = window, n = navigator, l = location;
  var s = d.currentScript;
  if (!s) {
    var all = d.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\\/wv\\.js(\\?|$)/.test(all[i].src) && all[i].getAttribute("data-key")) { s = all[i]; break; }
    }
  }
  var key = s && s.getAttribute("data-key");
  if (!key) return;
  var endpoint = s.src.replace(/\\/wv\\.js(\\?.*)?$/, "/wv/collect");
  function send(body) {
    var json = JSON.stringify(body);
    try { if (n.sendBeacon && n.sendBeacon(endpoint, json)) return; } catch (e) {}
    try { fetch(endpoint, { method: "POST", body: json, keepalive: true, mode: "no-cors", credentials: "omit" }); } catch (e) {}
  }
  if (w.__wvKey) {
    if (w.__wvKey !== key) send({ k: key, e: "conflict", u: l.href });
    return;
  }
  w.__wvKey = key;
  if (n.doNotTrack === "1" || w.doNotTrack === "1" || n.globalPrivacyControl === true) return;
  if (/[?&]wv_test=1(&|$)/.test(l.search)) send({ k: key, e: "test", u: l.href });
  function rand() {
    var a = new Uint8Array(12), c = w.crypto || w.msCrypto, h = "";
    if (c && c.getRandomValues) c.getRandomValues(a);
    else for (var j = 0; j < a.length; j++) a[j] = Math.floor(Math.random() * 256);
    for (var k = 0; k < a.length; k++) h += ("0" + a[k].toString(16)).slice(-2);
    return h;
  }
  var vid;
  try {
    vid = localStorage.getItem("_wv_id");
    if (!vid) { vid = rand(); localStorage.setItem("_wv_id", vid); }
  } catch (e) { vid = rand(); }
  var current = null, active = 0, since = 0;
  function now() { return new Date().getTime(); }
  function seconds() { return Math.round((active + (since ? now() - since : 0)) / 1000); }
  function leave(final) {
    if (!current) return;
    send({ k: key, v: vid, e: "leave", u: current, d: seconds() });
    if (final) current = null;
  }
  function view() {
    var url = l.href.split("#")[0];
    if (url === current) return;
    leave(true);
    current = url;
    active = 0;
    since = d.visibilityState === "hidden" ? 0 : now();
    send({ k: key, v: vid, e: "pageview", u: url, r: d.referrer || "", t: (d.title || "").slice(0, 300) });
  }
  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") {
      if (since) { active += now() - since; since = 0; }
      leave(false);
    } else if (current) since = now();
  });
  w.addEventListener("pagehide", function () { leave(true); });
  var push = history.pushState, replace = history.replaceState;
  history.pushState = function () { var r = push.apply(this, arguments); setTimeout(view, 0); return r; };
  history.replaceState = function () { var r = replace.apply(this, arguments); setTimeout(view, 0); return r; };
  w.addEventListener("popstate", function () { setTimeout(view, 0); });
  view();
})();
`;

// Sends one website visitor pageview (dev only).
// usage: node tools/dev/wvsim2.mjs <pixelKey> <visitorKey> <ip> <path>
//   node tools/dev/wvsim2.mjs wv_xxx v-admin 203.0.113.16 /admin/settings
// Env: API (default http://localhost:4000), SITE (default https://acme-outreach.test).
const [key, v, ip, path] = process.argv.slice(2);
if (!path) {
  console.error("usage: node tools/dev/wvsim2.mjs <pixelKey> <visitorKey> <ip> <path>");
  process.exit(1);
}
const API = process.env.API || "http://localhost:4000";
const site = process.env.SITE || "https://acme-outreach.test";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const res = await fetch(`${API}/wv/collect`, {
  method: "POST",
  headers: { "content-type": "text/plain", "user-agent": UA, origin: site, "x-forwarded-for": ip },
  body: JSON.stringify({ k: key, v, e: "pageview", u: `${site}${path}`, t: "Acme" }),
});
console.log(v, ip, path, res.status);

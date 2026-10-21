// Simulates website visitor snippet events against the local server (dev only).
// usage: node tools/dev/wvsim.mjs <pixelKey> [all|rejects|test|conflict]
// The pixel key is shown on Website visitors → Setup → See code (wv_...). The site domain must be acme-outreach.test
// (or set SITE=https://www.<your test domain>). Visits come from 203.0.113.x documentation addresses, which the
// IP lookup stand-in (tools/dev/mock/ipinfo-mock.mjs) answers for. Env: API (default http://localhost:4000).
const [key, scenario = "all"] = process.argv.slice(2);
if (!key) {
  console.error("usage: node tools/dev/wvsim.mjs <pixelKey> [all|rejects|test|conflict]");
  process.exit(1);
}
const API = process.env.API || "http://localhost:4000";
// A browser user agent: requests with curl/bot user agents are dropped as bots.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const site = process.env.SITE || "https://www.acme-outreach.test";
async function send(ev, { ip, ua = UA, origin = site } = {}) {
  const headers = { "content-type": "text/plain;charset=UTF-8", "user-agent": ua };
  if (origin) headers.origin = origin;
  if (ip) headers["x-forwarded-for"] = ip;
  const res = await fetch(`${API}/wv/collect`, { method: "POST", headers, body: JSON.stringify({ k: key, ...ev }) });
  return res.status;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visits = [
  { ip: "203.0.113.10", v: "v-verantora", pages: [["/", "https://www.google.com/search?q=outreach"], ["/pricing"], ["/customers"]] },
  { ip: "203.0.113.11", v: "v-junloop", pages: [["/?utm_source=linkedin&utm_campaign=q4"], ["/features"]] },
  { ip: "203.0.113.12", v: "v-tavtora", pages: [["/customers", "https://news.example.org/post"]] },
  { ip: "203.0.113.13", v: "v-isp", pages: [["/"]] },
  { ip: "203.0.113.14", v: "v-cloud", pages: [["/"]] },
  { ip: "203.0.113.15", v: "v-junimont", pages: [["/blog/cold-email"], ["/pricing"]] },
  { ip: "203.0.113.16", v: "v-northwind", pages: [["/"]] },
  { ip: null, v: "v-local", pages: [["/"]] },
  { ip: "203.0.113.17", v: "v-evorsio", pages: [["/pricing"]] },
];
if (scenario === "all") {
  for (const vis of visits) {
    for (const [path, ref] of vis.pages) {
      const s = await send({ v: vis.v, e: "pageview", u: `${site}${path}`, r: ref ?? "", t: `Acme ${path}` }, { ip: vis.ip ?? undefined });
      await sleep(150);
      const l = await send({ v: vis.v, e: "leave", u: `${site}${path.split("#")[0]}`, d: 20 + Math.floor(Math.random() * 60) }, { ip: vis.ip ?? undefined });
      console.log(vis.v, path, s, l);
    }
  }
}
if (scenario === "rejects") {
  console.log("bot", await send({ v: "v-bot", e: "pageview", u: `${site}/` }, { ip: "203.0.113.10", ua: "Googlebot/2.1" }));
  console.log("wrong host", await send({ v: "v-x", e: "pageview", u: "https://evil.test/" }, { ip: "203.0.113.10", origin: "https://evil.test" }));
  console.log("origin mismatch", await send({ v: "v-x", e: "pageview", u: `${site}/` }, { ip: "203.0.113.10", origin: "https://evil.test" }));
  console.log("bad key", await send({ v: "v-x", e: "pageview", u: `${site}/`, k: "wv_nope" }, { ip: "203.0.113.10" }));
  console.log("garbage", (await fetch(`${API}/wv/collect`, { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" })).status);
}
if (scenario === "test") console.log("test", await send({ e: "test", u: `${site}/?wv_test=1` }));
if (scenario === "conflict") console.log("conflict", await send({ e: "conflict", u: `${site}/` }));

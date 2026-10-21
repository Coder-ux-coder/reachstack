// Local stand-in for the IP lookup API (ipinfo-style JSON). Addresses are from the 203.0.113.0/24 documentation range.
// Usage: node ipinfo-mock.mjs [port]   (token: test-ipinfo). POST /hook logs webhook bodies sent to it.
import http from "node:http";

const port = Number(process.argv[2] ?? 4998);
const TOKEN = "test-ipinfo";
const business = (name, domain, extra = {}) => ({ company: { name, domain, type: "business" }, asn: { name: `${name} Network`, type: "business" }, ...extra });
const ANSWERS = {
  "8.8.8.8": { city: "Mountain View", region: "California", country: "US", org: "AS15169 Example DNS", asn: { type: "hosting" } },
  "203.0.113.10": business("Verantora", "verantora.test", { city: "Chicago", region: "Illinois", country: "US" }),
  "203.0.113.11": business("Junloop Inc.", "junloop.test", { city: "Denver", region: "Colorado", country: "US" }),
  "203.0.113.12": business("Tavtora Foods", "www.tavtorafoods.test", { city: "Leeds", region: "England", country: "GB" }),
  "203.0.113.13": { city: "Austin", region: "Texas", country: "US", org: "AS64501 Example Cable Communications", company: { name: "Example Cable", domain: "examplecable.test", type: "isp" } },
  "203.0.113.14": { city: "Ashburn", region: "Virginia", country: "US", org: "AS64502 Example Cloud", privacy: { hosting: true } },
  // A lookup plan without company data: only the network owner's name.
  "203.0.113.15": { city: "Lagos", region: "Lagos", country: "NG", org: "AS64503 Junimont Analytics" },
  "203.0.113.16": business("Northwind Example", "northwind.test", { city: "Seattle", region: "Washington", country: "US" }),
  "203.0.113.17": business("Evorsio", "evorsio.test", { city: "Boston", region: "Massachusetts", country: "US" }),
};

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/hook") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        console.log(new Date().toISOString(), "hook", raw);
        res.end("{}");
      });
      return;
    }
    const auth = req.headers.authorization ?? "";
    const m = /^\/([^/]+)\/json$/.exec(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (auth !== `Bearer ${TOKEN}`) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: { title: "Unknown token" } }));
    }
    if (!m) {
      res.statusCode = 404;
      return res.end("{}");
    }
    const ip = decodeURIComponent(m[1]);
    console.log(new Date().toISOString(), "lookup", ip);
    res.end(JSON.stringify({ ip, ...(ANSWERS[ip] ?? { city: "Somewhere", country: "US", org: "AS64999 Generic Broadband ISP", company: { name: "Generic ISP", domain: "isp.test", type: "isp" } }) }));
  })
  .listen(port, () => console.log(`ipinfo mock on ${port}`));

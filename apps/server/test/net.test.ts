// The outbound request guard (src/lib/net.ts): user-supplied URLs and mail hosts must not reach loopback,
// private, link-local or metadata addresses, however the address is written. ALLOW_PRIVATE_URLS is false here.
import "./helpers/setup";
import dns from "node:dns";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isPrivateIp, outbound, publicLookup, safeFetch } from "../src/lib/net";

const isBadRequest = (err: unknown) => (err as { statusCode?: number }).statusCode === 400;

describe("isPrivateIp", () => {
  const ipv4Private = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ];
  const ipv4Public = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "192.169.0.1", "100.128.0.1", "169.255.0.1"];

  it("counts loopback, private, link-local, shared and multicast IPv4 as private", () => {
    for (const ip of ipv4Private) assert.equal(isPrivateIp(ip), true, ip);
  });

  it("counts public IPv4 as public", () => {
    for (const ip of ipv4Public) assert.equal(isPrivateIp(ip), false, ip);
  });

  it("counts IPv6 loopback, unspecified, unique-local and link-local as private", () => {
    for (const ip of ["::1", "::", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "FE80::abcd", "fe80::1%eth0"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  it("counts every address in fe80::/10 as link-local, not just fe80::", () => {
    for (const ip of ["fe90::1", "fea0::1", "febf:ffff::1"]) assert.equal(isPrivateIp(ip), true, ip);
  });

  it("judges IPv4-mapped IPv6 in dotted form by the IPv4 address", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::FFFF:192.168.0.1"]) assert.equal(isPrivateIp(ip), true, ip);
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
  });

  it("judges IPv4-mapped IPv6 in hex form by the IPv4 address", () => {
    // ::ffff:7f00:1 is 127.0.0.1 and ::ffff:a9fe:a9fe is 169.254.169.254 (the cloud metadata service).
    for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0a00:0001", "::ffff:c0a8:0101", "0:0:0:0:0:ffff:7f00:1", "::FFFF:7F00:1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    assert.equal(isPrivateIp("::ffff:808:808"), false);
  });

  it("counts public IPv6 as public", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e"]) assert.equal(isPrivateIp(ip), false, ip);
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts http(s) URLs on public addresses", async () => {
    assert.equal((await assertPublicHttpUrl("https://93.184.216.34/hook?x=1")).hostname, "93.184.216.34");
    assert.equal((await assertPublicHttpUrl("http://[2606:4700:4700::1111]:8080/")).port, "8080");
  });

  it("rejects other schemes and things that aren't URLs", async () => {
    for (const raw of ["file:///etc/passwd", "ftp://93.184.216.34/", "gopher://93.184.216.34:25/", "javascript:alert(1)", "not a url", ""]) {
      await assert.rejects(assertPublicHttpUrl(raw), isBadRequest, raw);
    }
  });

  it("rejects loopback, private and metadata addresses however they are written", async () => {
    for (const raw of [
      "http://127.0.0.1:4000/api",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.0.10:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      await assert.rejects(assertPublicHttpUrl(raw), isBadRequest, raw);
    }
  });

  it("rejects IPv4-mapped IPv6 hosts (URLs normalise them to hex)", async () => {
    for (const raw of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data/", "http://[0:0:0:0:0:ffff:a00:1]/"]) {
      await assert.rejects(assertPublicHttpUrl(raw), isBadRequest, raw);
    }
  });

  it("rejects names that resolve to loopback", async () => {
    await assert.rejects(assertPublicHttpUrl("http://localhost:4000/"), isBadRequest);
  });

  it("rejects names that don't resolve", async () => {
    await assert.rejects(assertPublicHttpUrl("https://hooks.invalid/x"), isBadRequest);
  });
});

describe("safeFetch", () => {
  const realSend = outbound.send;
  afterEach(() => {
    outbound.send = realSend;
  });

  it("refuses a private address before making any request", async () => {
    let calls = 0;
    outbound.send = async () => {
      calls++;
      return new Response("ok");
    };
    await assert.rejects(safeFetch("http://127.0.0.1:9/"), isBadRequest);
    await assert.rejects(safeFetch("http://[::ffff:a9fe:a9fe]/"), isBadRequest);
    assert.equal(calls, 0);
  });

  it("checks every redirect, so a public URL can't bounce the request into a private network", async () => {
    const seen: string[] = [];
    outbound.send = async (url) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    };
    await assert.rejects(safeFetch("https://93.184.216.34/start"), isBadRequest);
    assert.deepEqual(seen, ["https://93.184.216.34/start"]);
  });

  it("follows public redirects and gives up after a few hops", async () => {
    let hop = 0;
    outbound.send = async () => new Response(null, { status: 302, headers: { location: `https://93.184.216.34/hop/${++hop}` } });
    await assert.rejects(safeFetch("https://93.184.216.34/start"), isBadRequest);
    assert.equal(hop, 5);
  });

  it("checks the address again as it connects, so a name can't switch to a private one after the check", async () => {
    // A name that answers the first lookup (the check) with a public address and the next (the connection) with the
    // metadata address. Requests look names up with publicLookup as they connect.
    const name = "rebind.example.test";
    const answers = ["93.184.216.34", "169.254.169.254"];
    const realLookup = dns.lookup;
    dns.lookup = ((host: string, options: unknown, callback: (...args: unknown[]) => void) =>
      host === name ? process.nextTick(callback, null, [{ address: answers.shift() ?? "169.254.169.254", family: 4 }]) : (realLookup as (...a: unknown[]) => unknown)(host, options, callback)) as typeof dns.lookup;
    const look = () => new Promise<{ err: (Error & { code?: string }) | null; addresses: unknown }>((resolve) => publicLookup(name, { all: true }, (err, addresses) => resolve({ err, addresses })));
    try {
      const first = await look();
      assert.equal(first.err, null);
      assert.deepEqual(first.addresses, [{ address: "93.184.216.34", family: 4 }]);
      const second = await look();
      assert.equal(second.err?.code, "EPRIVATE");
    } finally {
      dns.lookup = realLookup;
    }
  });
});

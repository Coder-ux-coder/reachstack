// Encryption at rest, password hashing, signed tokens and two-step codes (src/lib/crypto.ts, src/lib/totp.ts).
import "./helpers/setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decrypt, decryptJson, encrypt, encryptJson, hashPassword, hmac, signPayload, verifyHmac, verifyPayload, verifyPassword } from "../src/lib/crypto";
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, totpCode, verifyTotp } from "../src/lib/totp";

describe("encryption at rest", () => {
  it("round-trips text and JSON", () => {
    assert.equal(decrypt(encrypt("imap-password-for-tests")), "imap-password-for-tests");
    assert.deepEqual(decryptJson(encryptJson({ a: 1, b: ["x"] })), { a: 1, b: ["x"] });
  });

  it("uses a fresh IV each time, so equal secrets don't look equal", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    assert.notEqual(a, b);
    assert.match(a, /^v1:[A-Za-z0-9_-]+$/);
    assert.ok(!a.includes("same"));
  });

  it("refuses ciphertext that was tampered with", () => {
    const value = encrypt("do not change me");
    const raw = Buffer.from(value.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    assert.throws(() => decrypt(`v1:${raw.toString("base64url")}`));
  });

  it("returns null for empty or unversioned values", () => {
    assert.equal(decrypt(null), null);
    assert.equal(decrypt(""), null);
    assert.equal(decrypt("plain text"), null);
    assert.equal(decryptJson(undefined), null);
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery");
    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword("correct horse battery", stored), true);
    assert.equal(await verifyPassword("correct horse batterY", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  it("salts every hash", async () => {
    assert.notEqual(await hashPassword("same password"), await hashPassword("same password"));
  });

  it("rejects missing or malformed stored hashes", async () => {
    assert.equal(await verifyPassword("anything", null), false);
    assert.equal(await verifyPassword("anything", ""), false);
    assert.equal(await verifyPassword("anything", "md5$abc"), false);
    assert.equal(await verifyPassword("anything", "scrypt$16384$8$1$onlyfive"), false);
  });
});

describe("signed tokens", () => {
  it("round-trip a payload", () => {
    const token = signPayload({ email_id: "e1", scope: "unsubscribe" });
    assert.deepEqual(verifyPayload(token), { email_id: "e1", scope: "unsubscribe" });
  });

  it("reject a changed payload or signature", () => {
    const token = signPayload({ email_id: "e1" });
    const [body, sig] = token.split(".") as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ email_id: "e2" })).toString("base64url");
    assert.equal(verifyPayload(`${forgedBody}.${sig}`), null);
    assert.equal(verifyPayload(`${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`), null);
    assert.equal(verifyPayload(`${body}.`), null);
    assert.equal(verifyPayload(body), null);
    assert.equal(verifyPayload(""), null);
    assert.equal(verifyPayload(null), null);
  });

  it("compare MACs of any length without throwing", () => {
    const mac = hmac("value", 12);
    assert.equal(mac.length, 12);
    assert.equal(verifyHmac("value", mac, 12), true);
    assert.equal(verifyHmac("value", mac.slice(0, 11), 12), false);
    assert.equal(verifyHmac("other", mac, 12), false);
  });
});

describe("two-step codes (TOTP)", () => {
  // RFC 6238 appendix B: SHA-1 with the ASCII secret "12345678901234567890", 8 digits.
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890"));

  it("match the RFC 6238 test vectors", () => {
    assert.equal(rfcSecret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(totpCode(rfcSecret, 59_000, 30, 8), "94287082");
    assert.equal(totpCode(rfcSecret, 1_111_111_109_000, 30, 8), "07081804");
    assert.equal(totpCode(rfcSecret, 1_234_567_890_000, 30, 8), "89005924");
    assert.equal(totpCode(rfcSecret, 20_000_000_000_000, 30, 8), "65353130");
  });

  it("base32 round-trips any bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
    assert.equal(base32Decode(generateTotpSecret()).length, 20);
  });

  it("accept the current code and its neighbours only", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_015_000 });
    const now = Date.now();
    assert.equal(verifyTotp(rfcSecret, totpCode(rfcSecret, now)), true);
    assert.equal(verifyTotp(rfcSecret, totpCode(rfcSecret, now - 30_000)), true);
    assert.equal(verifyTotp(rfcSecret, totpCode(rfcSecret, now + 30_000)), true);
    assert.equal(verifyTotp(rfcSecret, totpCode(rfcSecret, now - 90_000)), false);
    assert.equal(verifyTotp(rfcSecret, totpCode(rfcSecret, now + 90_000)), false);
  });

  it("reject anything that isn't six digits", () => {
    const secret = generateTotpSecret();
    for (const code of ["", "12345", "1234567", "12345a", "abcdef"]) assert.equal(verifyTotp(secret, code), false, code);
  });

  it("recovery codes are random and well-formed", () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });
});

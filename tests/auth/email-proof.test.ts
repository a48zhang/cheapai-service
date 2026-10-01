import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEmailCode, hashEmailCode, normalizeEmail, verifyEmailCode } from "../../apps/worker/auth/email-proof";
import type { EmailProofInput } from "../../apps/worker/auth/email-proof";

afterEach(() => vi.restoreAllMocks());
const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const proof: EmailProofInput = { email: " Alice.Example+Tag@EXAMPLE.COM ", purpose: "registration", generation: 7, code: "012345" };
// Independently calculated with Python hmac/hashlib over the documented UTF-8 JSON tuple.
const knownMac = "c155261d9e06673b492d7347713307125bee8716d31ad4fd92d2a2a5b13a4f5c";

describe("email canonicalization boundaries", () => {
  it("trims and lowercases without merging dots, plus tags or provider aliases", () => {
    expect(normalizeEmail(proof.email)).toBe("alice.example+tag@example.com");
    expect(normalizeEmail("\u00a0User@Example.COM\u3000")).toBe("user@example.com");
    expect(normalizeEmail("a.b@example.com")).not.toBe(normalizeEmail("ab@example.com"));
    expect(normalizeEmail("a+tag@example.com")).not.toBe(normalizeEmail("a@example.com"));
    expect(normalizeEmail("a@example.com")).not.toBe(normalizeEmail("a@example.net"));
  });

  it("keeps Unicode spelling distinctions while applying ordinary lowercase", () => {
    expect(normalizeEmail("É+标签@例子.公司")).toBe("é+标签@例子.公司");
    expect(normalizeEmail("É@example.com")).not.toBe(normalizeEmail("E\u0301@example.com"));
    expect(normalizeEmail("Ａ@example.com")).not.toBe(normalizeEmail("A@example.com"));
    expect(normalizeEmail("İ@example.com")).toBe("i\u0307@example.com");
  });

  it("checks local, label and total limits in UTF-8 bytes after normalization", () => {
    expect(normalizeEmail(`${"é".repeat(32)}@example.com`)).toBe(`${"é".repeat(32)}@example.com`);
    expect(() => normalizeEmail(`${"é".repeat(33)}@example.com`)).toThrow(TypeError);
    expect(() => normalizeEmail(`a@${"x".repeat(64)}.com`)).toThrow(TypeError);
    const domain = `${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(61)}`;
    expect(normalizeEmail(`${"a".repeat(64)}@${domain}`)).toHaveLength(254);
    expect(() => normalizeEmail(`${"a".repeat(64)}@${domain}g`)).toThrow(TypeError);
    expect(() => normalizeEmail(`${"İ".repeat(22)}@example.com`)).toThrow(TypeError);
  });

  it.each(["", "a", "a@localhost", "@example.com", "a@@example.com", ".a@example.com", "a..b@example.com",
    "a.@example.com", "a b@example.com", "a\n@example.com", "a\0@example.com", "a\u200b@example.com", "a\ud800@example.com",
    "a@-example.com", "a@example-.com", "a@example..com", "a@example.com.", '"a"@example.com', "a＠example.com", null, 5])(
    "rejects malformed address %j", (email) => {
      expect(() => normalizeEmail(email as string)).toThrow(TypeError);
    },
  );
});

describe("native Workers email verification crypto", () => {
  it("generates exactly six ASCII digits with cryptographic randomness", () => {
    for (let index = 0; index < 256; index += 1) expect(generateEmailCode()).toMatch(/^[0-9]{6}$/);
  });

  it("rejects the biased tail and preserves both numeric endpoints", () => {
    const draws = [4_294_967_295, 4_294_000_000, 4_293_999_999, 0];
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = draws.shift()!;
      return array;
    });
    expect(generateEmailCode()).toBe("999999");
    expect(random).toHaveBeenCalledTimes(3);
    expect(generateEmailCode()).toBe("000000");
  });

  it("matches an independent HMAC-SHA256 vector and verifies normalized aliases", async () => {
    expect(await hashEmailCode(key, proof)).toBe(knownMac);
    expect(knownMac).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyEmailCode(key, { ...proof, email: "alice.example+tag@example.com" }, knownMac)).toBe(true);
  });

  it("binds mailbox, plus tag, dots, generation, purpose and all code digits", async () => {
    for (const change of [
      { email: "other@example.com" }, { email: "aliceexample+tag@example.com" },
      { email: "alice.example@example.com" }, { generation: 8 }, { code: "012346" },
      { purpose: "password_reset" }, { generation: 0 }, { code: "12345" }, { code: "012345\n" }, { code: "０１２３４５" },
    ]) {
      expect(await verifyEmailCode(key, { ...proof, ...change } as EmailProofInput, knownMac)).toBe(false);
    }
    const otherKey = new Uint8Array(32).fill(42);
    expect(await verifyEmailCode(otherKey, proof, knownMac)).toBe(false);
    expect(await verifyEmailCode(key, proof, "0" + knownMac.slice(1))).toBe(false);
    expect(await verifyEmailCode(key, proof, knownMac.slice(0, -1) + "0")).toBe(false);
  });

  it("does not merge distinct Unicode addresses in the MAC", async () => {
    const composed = { ...proof, email: "é@example.com" };
    const mac = await hashEmailCode(key, composed);
    expect(await verifyEmailCode(key, { ...proof, email: "e\u0301@example.com" }, mac)).toBe(false);
    expect(await verifyEmailCode(key, { ...proof, email: "É@EXAMPLE.COM" }, mac)).toBe(true);
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "g".repeat(64), knownMac.toUpperCase(), knownMac + "\n", null, {}])(
    "fails closed on malformed stored MAC %j", async (mac) => {
      expect(await verifyEmailCode(key, proof, mac)).toBe(false);
    },
  );

  it("rejects malformed signing context and undersized injected keys", async () => {
    for (const change of [{ purpose: "password_reset" }, { generation: NaN }, { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 }, { code: "abcdef" }, { email: "bad" }]) {
      await expect(hashEmailCode(key, { ...proof, ...change } as EmailProofInput)).rejects.toThrow(TypeError);
    }
    for (const short of [new Uint8Array(0), new Uint8Array(31), "not-key-bytes"]) {
      await expect(hashEmailCode(short as Uint8Array, proof)).rejects.toThrow(/at least 32 bytes/);
      await expect(verifyEmailCode(short as Uint8Array, proof, knownMac)).rejects.toThrow(/at least 32 bytes/);
    }
    const larger = new Uint8Array(64).fill(1);
    const mac = await hashEmailCode(larger, { ...proof, generation: Number.MAX_SAFE_INTEGER });
    expect(await verifyEmailCode(larger, { ...proof, generation: Number.MAX_SAFE_INTEGER }, mac)).toBe(true);
  });

  it("snapshots key bytes and propagates crypto failures without treating them as wrong codes", async () => {
    const copy = new Uint8Array(key);
    const signing = hashEmailCode(copy, proof);
    copy.fill(255);
    expect(await signing).toBe(knownMac);
    const failure = new Error("crypto unavailable");
    vi.spyOn(crypto.subtle, "verify").mockRejectedValueOnce(failure);
    await expect(verifyEmailCode(key, proof, knownMac)).rejects.toBe(failure);
  });
});

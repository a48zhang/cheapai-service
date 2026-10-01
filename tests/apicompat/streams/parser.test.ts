import { describe, expect, it } from "vitest";
import { SseByteParser, SseParser } from "../../../packages/apicompat/streams/parser.js";
import type { SseFrame } from "../../../packages/apicompat/types/shared.js";

describe("SseParser decoded-text framing", () => {
  it("handles every two-chunk boundary and one-character chunks identically", () => {
    const input = ': heartbeat\r\nevent: delta\rid: abc\nretry: 0015\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\n\n';
    const expected: SseFrame[] = [
      { event: "delta", id: "abc", retry: 15, data: '{"a":\n1}' },
      { id: "abc", retry: 15, data: "[DONE]" },
    ];
    for (let cut = 0; cut <= input.length; cut += 1) {
      const parser = new SseParser();
      expect([...parser.push(input.slice(0, cut)), ...parser.push(""), ...parser.push(input.slice(cut))]).toEqual(expected);
    }
    const parser = new SseParser();
    expect([...input].flatMap((char) => parser.push(char))).toEqual(expected);
  });

  it.each(["\n", "\r", "\r\n"])("dispatches only on a blank line with %j endings", (eol) => {
    const parser = new SseParser();
    expect(parser.push(`data: hello${eol}`)).toEqual([]);
    expect(parser.push(eol)).toEqual([{ data: "hello" }]);
    expect(parser.push(eol + eol)).toEqual([]);
  });

  it("does not treat the LF half of a split CRLF as a blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("data: b\r")).toEqual([]);
    expect(parser.push("\n\r")).toEqual([{ data: "a\nb" }]);
    expect(parser.push("\n")).toEqual([]);
  });

  it("joins data lines, preserves colons/whitespace, and accepts empty data", () => {
    const parser = new SseParser();
    expect(parser.push("data:  first: value \ndata:\tsecond\ndata\n\n"))
      .toEqual([{ data: " first: value \n\tsecond\n" }]);
    expect(parser.push("data:\n\ndata\n\n")).toEqual([{ data: "" }, { data: "" }]);
  });

  it("ignores heartbeat/comment-only blocks and literal unknown fields", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n:\n\nunknown: value\nData: wrong case\n data: spaced\n\n"))
      .toEqual([]);
    expect(parser.push("data: a\n: between lines\nunknown: discard\ndata: b\n\n"))
      .toEqual([{ data: "a\nb" }]);
  });

  it("uses the last event field and resets it on every blank line", () => {
    const parser = new SseParser();
    expect(parser.push("event: stale\n\nevent: first\nevent: second\ndata: x\n\ndata: y\n\n"))
      .toEqual([{ event: "second", data: "x" }, { data: "y" }]);
    expect(parser.push("event: named\nevent\ndata: z\n\n")).toEqual([{ data: "z" }]);
  });

  it("retains id updates from control blocks, ignores NUL, and supports reset", () => {
    const parser = new SseParser();
    expect(parser.lastEventId).toBeUndefined();
    expect(parser.push("id: old\nid: current\n\n")).toEqual([]);
    expect(parser.lastEventId).toBe("current");
    expect(parser.push("id: bad\0value\ndata: a\n\ndata: b\n\n"))
      .toEqual([{ id: "current", data: "a" }, { id: "current", data: "b" }]);
    expect(parser.push("id\n\ndata: c\n\n")).toEqual([{ id: "", data: "c" }]);
    expect(parser.lastEventId).toBe("");
  });

  it("accepts ASCII integer retry controls and rejects unsafe or malformed values", () => {
    const parser = new SseParser();
    expect(parser.retry).toBeUndefined();
    expect(parser.push("retry: 00042\n\n")).toEqual([]);
    expect(parser.retry).toBe(42);
    for (const value of ["", "-1", "+1", "1.5", "2e3", "４２", " 42", "42 ", "9007199254740992", "9".repeat(400)]) {
      expect(parser.push(`retry: ${value}\ndata: check\n\n`)).toEqual([{ data: "check", retry: 42 }]);
    }
    expect(parser.push("retry: 0\ndata: zero\n\n")).toEqual([{ data: "zero", retry: 0 }]);
  });

  it("strips one leading text BOM only and leaves payloads opaque", () => {
    const parser = new SseParser();
    expect(parser.push("")).toEqual([]);
    expect(parser.push("\ufeff")).toEqual([]);
    expect(parser.push('data: {not JSON\n\ndata: \ufeff[DONE]\n\ndata: [DONE]\n\n'))
      .toEqual([{ data: "{not JSON" }, { data: "\ufeff[DONE]" }, { data: "[DONE]" }]);
  });

  it.each(["data: partial", "data: partial\n", "event: delta\ndata: partial\r\n"])(
    "discards unclosed frames at EOF: %j", (input) => {
      const parser = new SseParser();
      expect(parser.push(input)).toEqual([]);
      expect(parser.finish()).toEqual([]);
      expect(parser.finish()).toEqual([]);
      expect(() => parser.push("\n")).toThrow("already finished");
    },
  );

  it("does not fabricate success at a frame boundary or repeat emitted frames", () => {
    const parser = new SseParser();
    expect(parser.push("data: ordinary content\n\n")).toEqual([{ data: "ordinary content" }]);
    expect(parser.finish()).toEqual([]);
  });
});

describe("SseByteParser UTF-8 transport framing", () => {
  const encoder = new TextEncoder();

  it("preserves multilingual text and CRLF at every byte split", () => {
    const bytes = encoder.encode("\ufeff: 心跳\r\nid: 标识🧭\r\nretry: 50\r\nevent: 增量\r\ndata: café 中文 🧭\r\ndata: e\u0301\r\n\r\ndata: next\r\n\r\n");
    const expected: SseFrame[] = [
      { id: "标识🧭", retry: 50, event: "增量", data: "café 中文 🧭\ne\u0301" },
      { id: "标识🧭", retry: 50, data: "next" },
    ];
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const parser = new SseByteParser();
      expect([
        ...parser.push(bytes.subarray(0, cut)),
        ...parser.push(new Uint8Array()),
        ...parser.push(bytes.subarray(cut)),
        ...parser.finish(),
      ]).toEqual(expected);
      expect(parser.lastEventId).toBe("标识🧭");
      expect(parser.retry).toBe(50);
    }
    const parser = new SseByteParser();
    expect([...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)))).toEqual(expected);
  });

  it("holds partial UTF-8 code points until subsequent bytes arrive", () => {
    const parser = new SseByteParser();
    expect(parser.push(encoder.encode("data: "))).toEqual([]);
    expect(parser.push(Uint8Array.of(0xf0, 0x9f))).toEqual([]);
    expect(parser.push(Uint8Array.of(0xa7))).toEqual([]);
    expect(parser.push(Uint8Array.of(0xad, 0x0d))).toEqual([]);
    expect(parser.push(Uint8Array.of(0x0a, 0x0d))).toEqual([{ data: "🧭" }]);
    expect(parser.push(Uint8Array.of(0x0a))).toEqual([]);
  });

  it("strips exactly one initial BOM even across empty and one-byte chunks", () => {
    const parser = new SseByteParser();
    expect(parser.push(new Uint8Array())).toEqual([]);
    for (const byte of [0xef, 0xbb, 0xbf]) expect(parser.push(Uint8Array.of(byte))).toEqual([]);
    expect(parser.push(encoder.encode("data: \ufeffkept\n\n\ufeffdata: ignored field\n\ndata: last\n\n")))
      .toEqual([{ data: "\ufeffkept" }, { data: "last" }]);
    const doubleBom = new SseByteParser();
    // The second BOM belongs to the field name, so that field is unknown.
    expect(doubleBom.push(encoder.encode("\ufeff\ufeffdata: ignored\n\ndata: visible\n\n")))
      .toEqual([{ data: "visible" }]);
  });

  it("replaces malformed UTF-8 consistently without swallowing ASCII delimiters", () => {
    const bytes = Uint8Array.from([
      ...encoder.encode("data: "), 0xe2, 0x28, 0xa1,
      ...encoder.encode("\n\ndata: "), 0xc3, ...encoder.encode("\n\n"),
    ]);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const parser = new SseByteParser();
      expect([...parser.push(bytes.subarray(0, cut)), ...parser.push(bytes.subarray(cut))])
        .toEqual([{ data: "\ufffd(\ufffd" }, { data: "\ufffd" }]);
      expect(parser.finish()).toEqual([]);
    }
  });

  it.each([
    Uint8Array.of(0xef, 0xbb),
    Uint8Array.from([...encoder.encode("data: text "), 0xf0, 0x9f]),
    encoder.encode("data: complete line\r\n"),
    encoder.encode("data: [DONE]"),
    encoder.encode("event: response.completed\ndata: {}\n"),
  ])("flushes EOF without dispatching a residual frame (%j)", (bytes) => {
    const parser = new SseByteParser();
    expect(parser.push(bytes)).toEqual([]);
    expect(parser.finish()).toEqual([]);
    expect(parser.finish()).toEqual([]);
    expect(() => parser.push(encoder.encode("\n\n"))).toThrow("already finished");
  });

  it("preserves dispatched frames but never completes an unfinished following frame", () => {
    const parser = new SseByteParser();
    expect(parser.push(Uint8Array.from([...encoder.encode("data: first\n\ndata: last "), 0xe2])))
      .toEqual([{ data: "first" }]);
    expect(parser.finish()).toEqual([]);
    expect(parser.finish()).toEqual([]);
    const empty = new SseByteParser();
    expect(empty.finish()).toEqual([]);
    expect(empty.finish()).toEqual([]);
  });

  it("rejects mixed input types before changing text or decoder state", () => {
    const text = new SseParser();
    text.push("data: start");
    expect(() => text.push(encoder.encode("bad") as unknown as string)).toThrow(TypeError);
    expect(text.push(" end\n\n")).toEqual([{ data: "start end" }]);

    const bytes = new SseByteParser();
    bytes.push(Uint8Array.from([...encoder.encode("data: "), 0xc3]));
    expect(() => bytes.push("bad" as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => bytes.push(new Uint16Array([1]) as unknown as Uint8Array)).toThrow(TypeError);
    expect(bytes.push(Uint8Array.of(0xa9, 0x0a, 0x0a))).toEqual([{ data: "é" }]);
  });
});

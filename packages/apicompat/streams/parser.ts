import type { SseFrame } from "../types/shared.js";

/**
 * Incremental decoded-text SSE parser, one instance per transport stream.
 * Original implementation following WHATWG HTML, sections 9.2.5–9.2.6:
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 *
 * Only blocks containing data fields emit frames (including `data:`). Comments,
 * heartbeat-only blocks and unknown fields are ignored. Empty/absent event means
 * the default "message" event and is omitted. Valid id/retry values persist across
 * blocks; getters also expose updates in blocks without data. Unsafe retry values
 * are ignored because SseFrame represents milliseconds as a JavaScript number.
 *
 * Payloads remain opaque strings, including JSON fragments and [DONE]. This class
 * does not decode bytes, infer provider completion, reconnect or own I/O limits.
 */
export class SseParser {
  private line = "";
  private skipLf = false;
  private atStart = true;
  private ended = false;
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private retryMs: number | undefined;

  get lastEventId(): string | undefined {
    return this.id;
  }

  get retry(): number | undefined {
    return this.retryMs;
  }

  push(text: string): SseFrame[] {
    if (this.ended) throw new Error("SSE parser is already finished");
    if (typeof text !== "string") throw new TypeError("SseParser accepts decoded strings only; use SseByteParser for bytes");
    const frames: SseFrame[] = [];
    let start = 0;
    if (this.atStart && text.length > 0) {
      this.atStart = false;
      if (text.charCodeAt(0) === 0xfeff) start = 1;
    }

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (this.skipLf) {
        this.skipLf = false;
        if (char === "\n") {
          start = index + 1;
          continue;
        }
      }
      if (char !== "\r" && char !== "\n") continue;

      this.processLine(this.line + text.slice(start, index), frames);
      this.line = "";
      start = index + 1;
      this.skipLf = char === "\r";
    }
    this.line += text.slice(start);
    return frames;
  }

  /** EOF discards pending data; it never substitutes for a blank line or [DONE]. */
  finish(): SseFrame[] {
    this.ended = true;
    this.line = "";
    this.data = [];
    this.event = "";
    this.skipLf = false;
    return [];
  }

  private processLine(line: string, frames: SseFrame[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        frames.push({
          data: this.data.join("\n"),
          ...(this.event !== "" ? { event: this.event } : {}),
          ...(this.id !== undefined ? { id: this.id } : {}),
          ...(this.retryMs !== undefined ? { retry: this.retryMs } : {}),
        });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry": {
        if (!/^[0-9]+$/.test(value)) break;
        const retry = Number(value);
        if (Number.isSafeInteger(retry)) this.retryMs = retry;
        break;
      }
      default:
        // Literal field names only; extensions do not become payload data.
        break;
    }
  }
}

/**
 * UTF-8 transport companion to SseParser; never mix bytes and decoded strings.
 * One TextDecoder retains incomplete code points across push calls. Malformed
 * UTF-8 uses the standard replacement policy (U+FFFD), not a per-chunk decoder.
 * https://encoding.spec.whatwg.org/#interface-textdecoder
 *
 * BOM handling belongs to SseParser: ignoreBOM=true preserves decoded U+FEFF so
 * exactly one initial BOM is stripped, even if its three bytes arrive separately.
 * A second BOM and BOMs inside payloads remain content, as required by SSE.
 * This parser does not own network reads, backpressure or buffer limits.
 */
export class SseByteParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  private readonly parser = new SseParser();
  private ended = false;

  get lastEventId(): string | undefined {
    return this.parser.lastEventId;
  }

  get retry(): number | undefined {
    return this.parser.retry;
  }

  push(bytes: Uint8Array): SseFrame[] {
    if (this.ended) throw new Error("SSE byte parser is already finished");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SseByteParser accepts Uint8Array only; use SseParser for text");
    return this.parser.push(this.decoder.decode(bytes, { stream: true }));
  }

  /** Flush decoding once, then discard any frame lacking its closing blank line. */
  finish(): SseFrame[] {
    if (this.ended) return [];
    this.ended = true;
    // EOF can produce U+FFFD for a partial code point, never an event delimiter.
    // Neither decoder EOF nor a complete SSE frame implies model completion.
    this.parser.push(this.decoder.decode());
    return this.parser.finish();
  }
}

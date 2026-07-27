/**
 * Memo encoding / decoding.
 *
 * A B20 memo is a bytes32 word. Text memos are NFC-normalized and encoded as
 * right-padded UTF-8. Encoding NEVER truncates: a memo that does not fit is a
 * hard error, because a silently shortened memo would be written to chain
 * permanently and would not say what the caller asked it to say.
 */
import { stringToHex, hexToString, isHex, type Hex } from "viem";

export const MEMO_MAX_BYTES = 32;

/**
 * Characters that are invisible, non-printing, or can reorder rendered text:
 * C0/C1 controls, soft hyphen, Mongolian vowel separator, zero-width and bidi
 * marks, bidi overrides and isolates, word joiner / invisible operators, BOM.
 */
const HIDDEN_CHAR = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0 and C1 controls
    "\\u00ad" + // soft hyphen
    "\\u180e" + // Mongolian vowel separator
    "\\u200b-\\u200f" + // zero-width space/joiners, LRM/RLM
    "\\u202a-\\u202e" + // bidi embeddings and overrides
    "\\u2060-\\u2064" + // word joiner, invisible operators
    "\\u2066-\\u2069" + // bidi isolates
    "\\ufeff" + // BOM / zero-width no-break space
    "]",
  "u",
);

export interface EncodedMemo {
  /** The bytes32 word that will be written on chain. */
  hex: Hex;
  /** NFC-normalized text, or null when the caller supplied raw bytes32. */
  normalized: string | null;
  /** UTF-8 byte length of the normalized text (32 for raw bytes32). */
  byteLength: number;
  /** True when the caller passed a raw 0x… bytes32 rather than text. */
  raw: boolean;
  /** True when NFC normalization changed the input. */
  normalizationChanged: boolean;
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Encode a memo to bytes32.
 *
 * Accepts either a raw 0x-prefixed bytes32 (66 chars, passed through verbatim)
 * or text, which is NFC-normalized then UTF-8 encoded and right-padded.
 * Throws — never truncates — when the text exceeds 32 UTF-8 bytes.
 */
export function encodeMemo(memo: string): EncodedMemo {
  if (typeof memo !== "string") {
    throw new Error("Memo must be a string.");
  }

  // Raw bytes32 passthrough: exactly 0x + 64 hex chars.
  if (isHex(memo) && memo.length === 66) {
    return {
      hex: memo as Hex,
      normalized: null,
      byteLength: MEMO_MAX_BYTES,
      raw: true,
      normalizationChanged: false,
    };
  }

  // A 0x-prefixed string that is *almost* bytes32 is far more likely a typo'd
  // hex memo than intentional text. Refuse rather than silently writing the
  // literal characters "0xdeadbeef" on chain.
  if (isHex(memo) && memo.length !== 66) {
    throw new Error(
      `Ambiguous memo: "${memo}" is 0x-prefixed hex but is ${memo.length - 2} hex chars, not 64. ` +
        `Pass a full 32-byte word (0x + 64 hex chars) for a raw memo, or text that does not start with 0x.`,
    );
  }

  if (memo.length === 0) {
    throw new Error(
      "Memo is empty. Provide text (<=32 UTF-8 bytes) or a raw 0x-prefixed bytes32.",
    );
  }

  const normalized = memo.normalize("NFC");
  const normalizationChanged = normalized !== memo;

  const hidden = HIDDEN_CHAR.exec(normalized);
  if (hidden) {
    const cp = hidden[0].codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase();
    throw new Error(
      `Memo contains a hidden or non-printing character (U+${cp}) at index ${hidden.index}. ` +
        `Memos are permanent and must render exactly as written — remove it and retry.`,
    );
  }

  const byteLength = utf8ByteLength(normalized);
  if (byteLength > MEMO_MAX_BYTES) {
    throw new Error(
      `Memo too long: ${byteLength} UTF-8 bytes after NFC normalization, limit is ${MEMO_MAX_BYTES}. ` +
        `Memos are bytes32 and are never truncated — shorten it by at least ${byteLength - MEMO_MAX_BYTES} byte(s) ` +
        `(emoji and accented characters cost more than one byte each).`,
    );
  }

  return {
    hex: stringToHex(normalized, { size: MEMO_MAX_BYTES }),
    normalized,
    byteLength,
    raw: false,
    normalizationChanged,
  };
}

/** bytes32 -> best-effort printable text, or null when it is not printable text. */
export function decodeMemo(hex: Hex): string | null {
  try {
    const s = hexToString(hex, { size: MEMO_MAX_BYTES }).replace(/ +$/, "");
    return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s) && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

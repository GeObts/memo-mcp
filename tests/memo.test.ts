import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeMemo, decodeMemo, utf8ByteLength, MEMO_MAX_BYTES } from "../src/memo.js";

// Test data is built from numeric code points on purpose: this file asserts on
// invisible and combining characters, and must not depend on how an editor or
// a diff tool happens to render or save them.
const cp = (n: number) => String.fromCodePoint(n);

const COMBINING_ACUTE = cp(0x0301);
const E_ACUTE_COMPOSED = cp(0x00e9);
const CAFE_DECOMPOSED = "cafe" + COMBINING_ACUTE;
const CAFE_COMPOSED = "caf" + E_ACUTE_COMPOSED;
const ROCKET = cp(0x1f680);

describe("encodeMemo", () => {
  test("encodes ASCII text to a right-padded bytes32", () => {
    const r = encodeMemo("AGENTS ARE HERE STOP");
    assert.equal(
      r.hex,
      "0x4147454e54532041524520484552452053544f50000000000000000000000000",
    );
    assert.equal(r.raw, false);
    assert.equal(r.byteLength, 20);
    assert.equal(r.normalized, "AGENTS ARE HERE STOP");
    assert.equal(r.hex.length, 66);
  });

  test("passes a raw 0x bytes32 through verbatim", () => {
    const raw = "0x4147454e54532041524520484552452053544f50000000000000000000000000";
    const r = encodeMemo(raw);
    assert.equal(r.hex, raw);
    assert.equal(r.raw, true);
    assert.equal(r.normalized, null);
  });

  test("accepts exactly 32 bytes", () => {
    const r = encodeMemo("a".repeat(32));
    assert.equal(r.byteLength, 32);
    assert.equal(r.hex.length, 66);
  });

  describe("NFC normalization", () => {
    test("normalizes decomposed input and reports the change", () => {
      const r = encodeMemo(CAFE_DECOMPOSED);
      assert.equal(r.normalized, CAFE_COMPOSED);
      assert.equal(r.normalizationChanged, true);
      // Decomposed is 6 UTF-8 bytes ("cafe" + a 2-byte combining mark); NFC gives 5.
      assert.equal(utf8ByteLength(CAFE_DECOMPOSED), 6);
      assert.equal(r.byteLength, 5);
    });

    test("composed and decomposed inputs produce the identical bytes32", () => {
      assert.equal(encodeMemo(CAFE_DECOMPOSED).hex, encodeMemo(CAFE_COMPOSED).hex);
    });

    test("leaves already-normalized input untouched", () => {
      assert.equal(encodeMemo(CAFE_COMPOSED).normalizationChanged, false);
    });

    test("normalization can bring an over-long memo under the limit", () => {
      // 16 decomposed e-acute = 48 UTF-8 bytes, over the limit; NFC composes
      // them to 16 * 2 = 32 bytes, exactly at it.
      const decomposed = ("e" + COMBINING_ACUTE).repeat(16);
      assert.equal(utf8ByteLength(decomposed), 48);
      const r = encodeMemo(decomposed);
      assert.equal(r.byteLength, 32);
      assert.equal(r.normalizationChanged, true);
    });
  });

  describe("length enforcement — never truncates", () => {
    test("throws above 32 UTF-8 bytes rather than truncating", () => {
      assert.throws(
        () => encodeMemo("a".repeat(33)),
        (err: Error) => {
          assert.match(err.message, /33 UTF-8 bytes/);
          assert.match(err.message, /never truncated/);
          return true;
        },
      );
    });

    test("counts multi-byte characters by bytes, not code points", () => {
      const emoji = ROCKET.repeat(9); // 9 rockets = 36 UTF-8 bytes
      assert.equal(utf8ByteLength(emoji), 36);
      assert.throws(() => encodeMemo(emoji), /36 UTF-8 bytes/);
    });

    test("8 rocket emoji (exactly 32 bytes) is accepted", () => {
      assert.equal(encodeMemo(ROCKET.repeat(8)).byteLength, MEMO_MAX_BYTES);
    });

    test("the error says how many bytes to remove", () => {
      assert.throws(() => encodeMemo("a".repeat(40)), /at least 8 byte\(s\)/);
    });
  });

  describe("hidden and ambiguous bytes", () => {
    const hidden: Array<[string, number]> = [
      ["zero-width space", 0x200b],
      ["zero-width non-joiner", 0x200c],
      ["zero-width joiner", 0x200d],
      ["left-to-right mark", 0x200e],
      ["right-to-left mark", 0x200f],
      ["left-to-right override", 0x202d],
      ["right-to-left override", 0x202e],
      ["left-to-right isolate", 0x2066],
      ["pop directional isolate", 0x2069],
      ["word joiner", 0x2060],
      ["invisible times", 0x2062],
      ["soft hyphen", 0x00ad],
      ["Mongolian vowel separator", 0x180e],
      ["BOM / zero-width no-break space", 0xfeff],
      ["null byte", 0x0000],
      ["escape control", 0x001b],
      ["delete control", 0x007f],
      ["C1 control", 0x0085],
    ];

    for (const [label, code] of hidden) {
      test(`rejects ${label} (U+${code.toString(16).toUpperCase().padStart(4, "0")})`, () => {
        assert.throws(
          () => encodeMemo("hello" + cp(code) + "world"),
          /hidden or non-printing character/,
        );
      });
    }

    test("names the offending code point and its index", () => {
      assert.throws(
        () => encodeMemo("hello" + cp(0x200b) + "world"),
        (err: Error) => {
          assert.match(err.message, /U\+200B/);
          assert.match(err.message, /index 5/);
          return true;
        },
      );
    });

    test("plain visible text with accents is still allowed", () => {
      assert.ok(encodeMemo("caf" + E_ACUTE_COMPOSED + " bill").hex.startsWith("0x"));
    });

    test("rejects 0x-prefixed hex that is not a full 32-byte word", () => {
      assert.throws(() => encodeMemo("0xdeadbeef"), /Ambiguous memo/);
    });

    test("rejects an empty memo", () => {
      assert.throws(() => encodeMemo(""), /Memo is empty/);
    });
  });
});

describe("decodeMemo", () => {
  test("round-trips printable text", () => {
    assert.equal(decodeMemo(encodeMemo("PAID INVOICE 42").hex), "PAID INVOICE 42");
  });

  test("returns null for non-printable bytes", () => {
    assert.equal(
      decodeMemo("0xdeadbeef00000000000000000000000000000000000000000000000000000000"),
      null,
    );
  });

  test("returns null for an all-zero word", () => {
    assert.equal(
      decodeMemo("0x0000000000000000000000000000000000000000000000000000000000000000"),
      null,
    );
  });
});

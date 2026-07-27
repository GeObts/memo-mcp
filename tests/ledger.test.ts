import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { createLedger, createMemoryLedger, LEDGER_VERSION } from "../src/ledger.js";

const TOKEN = getAddress("0xB20000000000000000000001BB894FF0C9e82bf3");
const OTHER = getAddress("0x4200000000000000000000000000000000000006");
const one = 10n ** 18n;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memo-ledger-"));
  path = join(dir, "spend.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("spend ledger", () => {
  test("a fresh ledger reports zero spent", () => {
    assert.equal(createLedger(path).spent(TOKEN), 0n);
  });

  test("a reservation is recorded immediately", () => {
    const ledger = createLedger(path);
    ledger.reserve(TOKEN, 5n * one);
    assert.equal(ledger.spent(TOKEN), 5n * one);
  });

  test("reservations accumulate", () => {
    const ledger = createLedger(path);
    ledger.reserve(TOKEN, 5n * one);
    ledger.reserve(TOKEN, 3n * one);
    assert.equal(ledger.spent(TOKEN), 8n * one);
  });

  test("spend survives a restart — the whole point of persisting it", () => {
    createLedger(path).reserve(TOKEN, 7n * one);
    // A brand new process reading the same file must still see the spend.
    assert.equal(createLedger(path).spent(TOKEN), 7n * one);
  });

  test("releasing a reservation gives the headroom back", () => {
    const ledger = createLedger(path);
    const r = ledger.reserve(TOKEN, 5n * one);
    r.release();
    assert.equal(ledger.spent(TOKEN), 0n);
  });

  test("releasing twice is a no-op — headroom cannot be conjured", () => {
    const ledger = createLedger(path);
    ledger.reserve(TOKEN, 10n * one);
    const r = ledger.reserve(TOKEN, 5n * one);
    r.release();
    r.release();
    r.release();
    assert.equal(ledger.spent(TOKEN), 10n * one);
  });

  test("release never drives the total below zero", () => {
    const ledger = createLedger(path);
    const r = ledger.reserve(TOKEN, 5n * one);
    // Simulate the file being reset underneath us between reserve and release.
    writeFileSync(path, JSON.stringify({ version: LEDGER_VERSION, spent: {} }));
    r.release();
    assert.equal(ledger.spent(TOKEN), 0n);
  });

  test("tracks tokens independently", () => {
    const ledger = createLedger(path);
    ledger.reserve(TOKEN, 5n * one);
    ledger.reserve(OTHER, 2n * one);
    assert.equal(ledger.spent(TOKEN), 5n * one);
    assert.equal(ledger.spent(OTHER), 2n * one);
  });

  test("is case-insensitive about the token address", () => {
    const ledger = createLedger(path);
    ledger.reserve(TOKEN, 5n * one);
    assert.equal(ledger.spent(TOKEN.toLowerCase() as typeof TOKEN), 5n * one);
  });

  test("stores wei as a decimal string, not a lossy number", () => {
    const ledger = createLedger(path);
    const odd = 123_456_789_012_345_678_901n;
    ledger.reserve(TOKEN, odd);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.spent[TOKEN.toLowerCase()], odd.toString());
    assert.equal(ledger.spent(TOKEN), odd);
  });

  describe("fails closed", () => {
    test("on corrupt JSON rather than reading as zero spent", () => {
      writeFileSync(path, "{ not json");
      assert.throws(() => createLedger(path).spent(TOKEN), /corrupt/);
    });

    test("on a truncated file rather than reading as zero spent", () => {
      writeFileSync(path, '{"version":1,"spent":{"0xb2');
      assert.throws(() => createLedger(path).spent(TOKEN), /corrupt/);
    });

    test("on an unrecognised ledger version", () => {
      writeFileSync(path, JSON.stringify({ version: 99, spent: {} }));
      assert.throws(() => createLedger(path).spent(TOKEN), /not a version 1 ledger/);
    });

    test("and says the cap cannot be enforced", () => {
      writeFileSync(path, "garbage");
      assert.throws(() => createLedger(path).spent(TOKEN), /MEMO_MAX_TOTAL cap cannot be enforced/);
    });
  });
});

describe("in-memory ledger (test double)", () => {
  test("behaves like the persistent one", () => {
    const ledger = createMemoryLedger();
    assert.equal(ledger.spent(TOKEN), 0n);
    const r = ledger.reserve(TOKEN, 5n * one);
    assert.equal(ledger.spent(TOKEN), 5n * one);
    r.release();
    r.release();
    assert.equal(ledger.spent(TOKEN), 0n);
  });
});

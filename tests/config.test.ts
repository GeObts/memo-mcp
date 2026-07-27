import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, MEMO_DEFAULT_CA, DEFAULT_RPC_URL } from "../src/config.js";
import { assertWithinCaps, capStatus } from "../src/caps.js";
import { getAddress } from "viem";

const KEY = "0x" + "11".repeat(32);

/** A minimal environment that is allowed to boot with sends enabled. */
function sendingEnv(extra: Record<string, string | undefined> = {}) {
  return {
    MEMO_PRIVATE_KEY: KEY,
    MEMO_MAX_PER_SEND: "10",
    MEMO_MAX_TOTAL: "100",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  test("boots read-only with an empty environment", () => {
    const c = loadConfig({});
    assert.equal(c.sendEnabled, false);
    assert.equal(c.token, getAddress(MEMO_DEFAULT_CA));
    assert.equal(c.rpcUrl, DEFAULT_RPC_URL);
    assert.equal(c.expectedChainId, 8453);
  });

  test("read-only mode does not require caps — it cannot spend anything", () => {
    assert.doesNotThrow(() => loadConfig({ RPC_URL: "https://example.invalid" }));
  });

  test("boots with a signer when both caps are set", () => {
    const c = loadConfig(sendingEnv());
    assert.equal(c.sendEnabled, true);
    assert.equal(c.maxPerSend, "10");
    assert.equal(c.maxTotal, "100");
  });

  describe("refuses to boot", () => {
    test("with a key but no caps at all", () => {
      assert.throws(
        () => loadConfig({ MEMO_PRIVATE_KEY: KEY }),
        /Refusing to boot.*MEMO_MAX_PER_SEND and MEMO_MAX_TOTAL are unset/s,
      );
    });

    test("with a key and only MEMO_MAX_PER_SEND", () => {
      assert.throws(
        () => loadConfig({ MEMO_PRIVATE_KEY: KEY, MEMO_MAX_PER_SEND: "10" }),
        /MEMO_MAX_TOTAL is unset/,
      );
    });

    test("with a key and only MEMO_MAX_TOTAL", () => {
      assert.throws(
        () => loadConfig({ MEMO_PRIVATE_KEY: KEY, MEMO_MAX_TOTAL: "100" }),
        /MEMO_MAX_PER_SEND is unset/,
      );
    });

    test("with caps set to empty strings", () => {
      assert.throws(
        () => loadConfig({ MEMO_PRIVATE_KEY: KEY, MEMO_MAX_PER_SEND: "  ", MEMO_MAX_TOTAL: "" }),
        /Refusing to boot/,
      );
    });

    test("and explains both remedies", () => {
      assert.throws(() => loadConfig({ MEMO_PRIVATE_KEY: KEY }), /can be drained by a single bad call/);
      assert.throws(() => loadConfig({ MEMO_PRIVATE_KEY: KEY }), /unset MEMO_PRIVATE_KEY to run read-only/);
    });

    test("on a zero cap", () => {
      assert.throws(
        () => loadConfig(sendingEnv({ MEMO_MAX_PER_SEND: "0" })),
        /must be greater than zero/,
      );
    });

    test("on a non-numeric cap", () => {
      assert.throws(
        () => loadConfig(sendingEnv({ MEMO_MAX_TOTAL: "lots" })),
        /must be a non-negative decimal number/,
      );
    });

    test("on a negative cap", () => {
      assert.throws(() => loadConfig(sendingEnv({ MEMO_MAX_TOTAL: "-5" })), /non-negative decimal/);
    });

    test("when the per-send cap exceeds the total cap", () => {
      assert.throws(
        () => loadConfig(sendingEnv({ MEMO_MAX_PER_SEND: "500", MEMO_MAX_TOTAL: "100" })),
        /can never bind/,
      );
    });

    test("on a malformed private key", () => {
      assert.throws(
        () => loadConfig(sendingEnv({ MEMO_PRIVATE_KEY: "hunter2" })),
        /must be a 0x-prefixed 32-byte hex private key/,
      );
      assert.throws(
        () => loadConfig(sendingEnv({ MEMO_PRIVATE_KEY: "0xabc" })),
        /32-byte hex private key/,
      );
    });

    test("on a malformed token address", () => {
      assert.throws(
        () => loadConfig({ MEMO_TOKEN_ADDRESS: "0xnope" }),
        /is not a valid address/,
      );
    });

    test("on a malformed MEMO_FROM_BLOCK", () => {
      assert.throws(
        () => loadConfig({ MEMO_FROM_BLOCK: "latest" }),
        /must be a non-negative integer/,
      );
    });
  });

  test("accepts decimal caps", () => {
    const c = loadConfig(sendingEnv({ MEMO_MAX_PER_SEND: "0.5", MEMO_MAX_TOTAL: "2.25" }));
    assert.equal(c.maxPerSend, "0.5");
    assert.equal(c.maxTotal, "2.25");
  });

  test("checksums a lowercase token address", () => {
    const c = loadConfig({ MEMO_TOKEN_ADDRESS: MEMO_DEFAULT_CA.toLowerCase() });
    assert.equal(c.token, getAddress(MEMO_DEFAULT_CA));
  });

  test("honours an explicit ledger path", () => {
    const c = loadConfig({ MEMO_SPEND_LEDGER: "/tmp/spend.json" });
    assert.equal(c.ledgerPath, "/tmp/spend.json");
  });

  test("parses MEMO_FROM_BLOCK as a bigint", () => {
    assert.equal(loadConfig({ MEMO_FROM_BLOCK: "48000000" }).defaultFromBlock, 48_000_000n);
  });
});

describe("spend caps", () => {
  const decimals = 18;
  const one = 10n ** 18n;

  test("allows a send inside both caps", () => {
    assert.doesNotThrow(() =>
      assertWithinCaps({ amountWei: one, decimals, maxPerSend: "10", maxTotal: "100", spentWei: 0n }),
    );
  });

  test("allows a send exactly at the per-send cap", () => {
    assert.doesNotThrow(() =>
      assertWithinCaps({ amountWei: 10n * one, decimals, maxPerSend: "10", maxTotal: "100", spentWei: 0n }),
    );
  });

  test("refuses one wei over the per-send cap", () => {
    assert.throws(
      () =>
        assertWithinCaps({
          amountWei: 10n * one + 1n,
          decimals,
          maxPerSend: "10",
          maxTotal: "100",
          spentWei: 0n,
        }),
      /exceeds MEMO_MAX_PER_SEND=10/,
    );
  });

  test("refuses a send that would breach the lifetime total", () => {
    assert.throws(
      () =>
        assertWithinCaps({
          amountWei: 5n * one,
          decimals,
          maxPerSend: "10",
          maxTotal: "100",
          spentWei: 96n * one,
        }),
      /would exceed MEMO_MAX_TOTAL=100/,
    );
  });

  test("allows a send that lands exactly on the total", () => {
    assert.doesNotThrow(() =>
      assertWithinCaps({
        amountWei: 4n * one,
        decimals,
        maxPerSend: "10",
        maxTotal: "100",
        spentWei: 96n * one,
      }),
    );
  });

  test("the total-cap error reports spent and remaining", () => {
    assert.throws(
      () =>
        assertWithinCaps({
          amountWei: 5n * one,
          decimals,
          maxPerSend: "10",
          maxTotal: "100",
          spentWei: 96n * one,
        }),
      /Already spent 96, 4 remaining, requested 5/,
    );
  });

  test("respects non-18-decimal tokens", () => {
    const sixDp = 1_000_000n;
    assert.throws(
      () =>
        assertWithinCaps({
          amountWei: 11n * sixDp,
          decimals: 6,
          maxPerSend: "10",
          maxTotal: "100",
          spentWei: 0n,
        }),
      /exceeds MEMO_MAX_PER_SEND/,
    );
    assert.doesNotThrow(() =>
      assertWithinCaps({
        amountWei: 9n * sixDp,
        decimals: 6,
        maxPerSend: "10",
        maxTotal: "100",
        spentWei: 0n,
      }),
    );
  });

  test("capStatus reports remaining headroom, clamped at zero", () => {
    const s = capStatus({ decimals, maxPerSend: "10", maxTotal: "100", spentWei: 120n * one });
    assert.equal(s.remainingWei, 0n);
  });
});

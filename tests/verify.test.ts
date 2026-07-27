import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pad, type Address, type Hex } from "viem";
import { verifyReceipt, type ExpectedSend, type ReceiptLike } from "../src/verify.js";
import { MEMO_TOPIC0, TRANSFER_TOPIC0 } from "../src/events.js";

const TOKEN = "0xB20000000000000000000001BB894FF0C9e82bf3" as Address;
const OTHER_TOKEN = "0x4200000000000000000000000000000000000006" as Address;
const SIGNER = "0x56A9B5c20a960B15331419D4eC608DBCFd83A01E" as Address;
const RECIPIENT = "0x75C83356987c8d813829D9FBb5DE504b547750A6" as Address;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;

const MEMO_HEX =
  "0x4147454e54532041524520484552452053544f50000000000000000000000000" as Hex;
const AMOUNT = 1_000_000_000_000_000_000n;

const addrTopic = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });
const valueData = (v: bigint) => pad(`0x${v.toString(16)}` as Hex, { size: 32 });

const expected: ExpectedSend = {
  token: TOKEN,
  from: SIGNER,
  to: RECIPIENT,
  amountWei: AMOUNT,
  memoHex: MEMO_HEX,
};

/** A well-formed receipt: Transfer at logIndex 93, its Memo at 94. */
function goodReceipt(overrides: Partial<ReceiptLike> = {}): ReceiptLike {
  return {
    status: "success",
    logs: [
      {
        address: TOKEN,
        topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(RECIPIENT)],
        data: valueData(AMOUNT),
        logIndex: 93,
      },
      {
        address: TOKEN,
        topics: [MEMO_TOPIC0, addrTopic(SIGNER), MEMO_HEX],
        data: "0x",
        logIndex: 94,
      },
    ],
    ...overrides,
  };
}

describe("verifyReceipt", () => {
  test("verifies a correct receipt", () => {
    const r = verifyReceipt(goodReceipt(), expected);
    assert.equal(r.verified, true);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.transferLogIndex, 93);
    assert.equal(r.memoLogIndex, 94);
  });

  test("tolerates unrelated logs from other contracts in the same tx", () => {
    const receipt = goodReceipt();
    const withNoise: ReceiptLike = {
      status: "success",
      logs: [
        { address: OTHER_TOKEN, topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(ATTACKER)], data: valueData(999n), logIndex: 12 },
        ...receipt.logs,
        { address: OTHER_TOKEN, topics: ["0xabc"], data: "0x", logIndex: 95 },
      ],
    };
    assert.equal(verifyReceipt(withNoise, expected).verified, true);
  });

  test("matches case-insensitively on addresses and topics", () => {
    const receipt = goodReceipt();
    const mixed: ReceiptLike = {
      status: "success",
      logs: receipt.logs.map((l) => ({
        ...l,
        address: l.address.toLowerCase(),
        topics: l.topics.map((t) => t.toUpperCase().replace("0X", "0x")),
      })),
    };
    assert.equal(verifyReceipt(mixed, expected).verified, true);
  });

  describe("rejects", () => {
    test("a reverted transaction", () => {
      const r = verifyReceipt(goodReceipt({ status: "reverted" }), expected);
      assert.equal(r.verified, false);
      assert.match(r.reasons[0], /reverted on chain/);
    });

    test("a receipt with no logs at all", () => {
      const r = verifyReceipt({ status: "success", logs: [] }, expected);
      assert.equal(r.verified, false);
      assert.match(r.reasons[0], /No logs from the pinned token/);
    });

    test("a receipt with no Memo event", () => {
      const receipt = goodReceipt();
      const r = verifyReceipt(
        { status: "success", logs: [receipt.logs[0]] },
        expected,
      );
      assert.equal(r.verified, false);
      assert.match(r.reasons[0], /No Memo event/);
    });

    test("a different memo word — the headline case", () => {
      const receipt = goodReceipt();
      const tampered: ReceiptLike = {
        status: "success",
        logs: [
          receipt.logs[0],
          { ...receipt.logs[1], topics: [MEMO_TOPIC0, addrTopic(SIGNER), pad("0xdead", { size: 32 })] },
        ],
      };
      const r = verifyReceipt(tampered, expected);
      assert.equal(r.verified, false);
      assert.match(r.reasons[0], /Memo word mismatch/);
    });

    test("a payment to the wrong recipient", () => {
      const receipt = goodReceipt();
      const redirected: ReceiptLike = {
        status: "success",
        logs: [
          { ...receipt.logs[0], topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(ATTACKER)] },
          receipt.logs[1],
        ],
      };
      const r = verifyReceipt(redirected, expected);
      assert.equal(r.verified, false);
      assert.ok(r.reasons.some((x) => /Recipient mismatch/.test(x)));
      assert.ok(r.reasons.some((x) => /did NOT go where it was requested/.test(x)));
    });

    test("a payment of the wrong amount", () => {
      const receipt = goodReceipt();
      const short: ReceiptLike = {
        status: "success",
        logs: [{ ...receipt.logs[0], data: valueData(1n) }, receipt.logs[1]],
      };
      const r = verifyReceipt(short, expected);
      assert.equal(r.verified, false);
      assert.ok(r.reasons.some((x) => /Amount mismatch/.test(x)));
      assert.ok(r.reasons.some((x) => new RegExp(`${AMOUNT} wei`).test(x)));
    });

    test("an off-by-one-wei amount", () => {
      const receipt = goodReceipt();
      const off: ReceiptLike = {
        status: "success",
        logs: [{ ...receipt.logs[0], data: valueData(AMOUNT - 1n) }, receipt.logs[1]],
      };
      assert.equal(verifyReceipt(off, expected).verified, false);
    });

    test("a Memo emitted by a different caller", () => {
      const receipt = goodReceipt();
      const spoofed: ReceiptLike = {
        status: "success",
        logs: [
          receipt.logs[0],
          { ...receipt.logs[1], topics: [MEMO_TOPIC0, addrTopic(ATTACKER), MEMO_HEX] },
        ],
      };
      const r = verifyReceipt(spoofed, expected);
      assert.equal(r.verified, false);
      assert.ok(r.reasons.some((x) => /Memo caller mismatch/.test(x)));
    });

    test("logs emitted by a different token contract", () => {
      const receipt = goodReceipt();
      const wrongToken: ReceiptLike = {
        status: "success",
        logs: receipt.logs.map((l) => ({ ...l, address: OTHER_TOKEN })),
      };
      const r = verifyReceipt(wrongToken, expected);
      assert.equal(r.verified, false);
      assert.match(r.reasons[0], /No logs from the pinned token/);
    });

    test("a Memo with no Transfer immediately before it", () => {
      const receipt = goodReceipt();
      const orphan: ReceiptLike = { status: "success", logs: [receipt.logs[1]] };
      const r = verifyReceipt(orphan, expected);
      assert.equal(r.verified, false);
      assert.ok(r.reasons.some((x) => /not joined to a payment/.test(x)));
    });

    test("a Memo joined to a non-Transfer log", () => {
      const receipt = goodReceipt();
      const bogus: ReceiptLike = {
        status: "success",
        logs: [
          { address: TOKEN, topics: ["0x" + "11".repeat(32)], data: "0x", logIndex: 93 },
          receipt.logs[1],
        ],
      };
      const r = verifyReceipt(bogus, expected);
      assert.equal(r.verified, false);
      assert.ok(r.reasons.some((x) => /is not a Transfer event/.test(x)));
    });
  });

  test("reports every mismatch, not just the first", () => {
    const receipt = goodReceipt();
    const multi: ReceiptLike = {
      status: "success",
      logs: [
        { ...receipt.logs[0], topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(ATTACKER)], data: valueData(5n) },
        { ...receipt.logs[1], topics: [MEMO_TOPIC0, addrTopic(ATTACKER), MEMO_HEX] },
      ],
    };
    const r = verifyReceipt(multi, expected);
    assert.equal(r.verified, false);
    assert.ok(r.reasons.length >= 3, `expected several reasons, got ${r.reasons.length}`);
  });

  test("picks our memo out of a transaction carrying several", () => {
    const otherMemo = pad("0xbeef", { size: 32 });
    const multi: ReceiptLike = {
      status: "success",
      logs: [
        { address: TOKEN, topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(ATTACKER)], data: valueData(7n), logIndex: 10 },
        { address: TOKEN, topics: [MEMO_TOPIC0, addrTopic(SIGNER), otherMemo], data: "0x", logIndex: 11 },
        { address: TOKEN, topics: [TRANSFER_TOPIC0, addrTopic(SIGNER), addrTopic(RECIPIENT)], data: valueData(AMOUNT), logIndex: 12 },
        { address: TOKEN, topics: [MEMO_TOPIC0, addrTopic(SIGNER), MEMO_HEX], data: "0x", logIndex: 13 },
      ],
    };
    const r = verifyReceipt(multi, expected);
    assert.equal(r.verified, true);
    assert.equal(r.memoLogIndex, 13);
    assert.equal(r.transferLogIndex, 12);
  });
});

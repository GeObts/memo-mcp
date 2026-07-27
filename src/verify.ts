/**
 * Post-broadcast receipt verification.
 *
 * A transaction hash proves only that a transaction was *broadcast*. It does
 * not prove it was mined, that it succeeded, or that it moved the amount the
 * caller asked for to the address the caller asked for. So send_memo does not
 * report success until the mined receipt has been decoded and every field of
 * the request has been matched against the emitted logs.
 */
import { getAddress, type Address, type Hex } from "viem";
import { TRANSFER_TOPIC0, MEMO_TOPIC0 } from "./events.js";

/** Terminal state of a send, as reported to the caller. */
export type SendState =
  /** Mined, status success, and every log matched the request. */
  | "confirmed"
  /** Mined, but the EVM reverted it. Nothing moved. */
  | "reverted"
  /** Mined and status success, but the logs do NOT match what was requested. */
  | "unverified"
  /** Broadcast, but no receipt was seen before the timeout. Outcome unknown. */
  | "broadcast";

export interface ExpectedSend {
  token: Address;
  from: Address;
  to: Address;
  amountWei: bigint;
  memoHex: Hex;
}

export interface ReceiptLike {
  status: "success" | "reverted";
  logs: ReadonlyArray<{
    address: string;
    topics: ReadonlyArray<string>;
    data: string;
    logIndex: number;
  }>;
}

export interface VerificationResult {
  verified: boolean;
  reasons: string[];
  transferLogIndex: number | null;
  memoLogIndex: number | null;
}

function topicToAddress(topic: string | undefined): Address | null {
  if (typeof topic !== "string" || topic.length !== 66) return null;
  try {
    return getAddress(("0x" + topic.slice(26)) as Hex);
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a as Hex) === getAddress(b as Hex);
  } catch {
    return false;
  }
}

/**
 * Verify a mined receipt against the request that produced it.
 *
 * Requires, all from the pinned token contract:
 *   - receipt status success
 *   - a Memo log whose caller is the signer and whose memo word is exactly the
 *     bytes32 we encoded
 *   - the Transfer log immediately before it (logIndex - 1, the join the read
 *     path relies on) with matching from, to, and value
 *
 * Returns every failed check rather than the first, so a mismatch is diagnosable.
 */
export function verifyReceipt(
  receipt: ReceiptLike,
  expected: ExpectedSend,
): VerificationResult {
  const reasons: string[] = [];

  if (receipt.status !== "success") {
    return {
      verified: false,
      reasons: [`Transaction reverted on chain (receipt status "${receipt.status}").`],
      transferLogIndex: null,
      memoLogIndex: null,
    };
  }

  const fromToken = receipt.logs.filter((l) => sameAddress(l.address, expected.token));
  if (fromToken.length === 0) {
    return {
      verified: false,
      reasons: [`No logs from the pinned token ${expected.token} in this receipt.`],
      transferLogIndex: null,
      memoLogIndex: null,
    };
  }

  const memoLogs = fromToken.filter(
    (l) => l.topics[0]?.toLowerCase() === MEMO_TOPIC0.toLowerCase(),
  );
  if (memoLogs.length === 0) {
    return {
      verified: false,
      reasons: [`No Memo event emitted by ${expected.token} in this receipt.`],
      transferLogIndex: null,
      memoLogIndex: null,
    };
  }

  // Match the Memo log by its indexed memo word, so a tx containing several
  // memos still verifies against ours specifically.
  const memoLog =
    memoLogs.find(
      (l) => l.topics[2]?.toLowerCase() === expected.memoHex.toLowerCase(),
    ) ?? null;

  if (!memoLog) {
    const seen = memoLogs.map((l) => l.topics[2] ?? "<none>").join(", ");
    return {
      verified: false,
      reasons: [
        `Memo word mismatch: expected ${expected.memoHex}, but the Memo event(s) in this ` +
          `transaction carried ${seen}.`,
      ],
      transferLogIndex: null,
      memoLogIndex: null,
    };
  }

  const memoCaller = topicToAddress(memoLog.topics[1]);
  if (memoCaller !== expected.from) {
    reasons.push(
      `Memo caller mismatch: expected ${expected.from}, got ${memoCaller ?? "<unreadable>"}.`,
    );
  }

  // The Memo event is emitted immediately after the Transfer it annotates.
  const transferLog = receipt.logs.find((l) => l.logIndex === memoLog.logIndex - 1) ?? null;

  if (!transferLog) {
    reasons.push(
      `No log at logIndex ${memoLog.logIndex - 1}; the Memo event is not joined to a payment.`,
    );
    return {
      verified: false,
      reasons,
      transferLogIndex: null,
      memoLogIndex: memoLog.logIndex,
    };
  }

  if (!sameAddress(transferLog.address, expected.token)) {
    reasons.push(
      `Payment log is from ${transferLog.address}, not the pinned token ${expected.token}.`,
    );
  }
  if (transferLog.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0.toLowerCase()) {
    reasons.push(`Log at logIndex ${transferLog.logIndex} is not a Transfer event.`);
  } else {
    const transferFrom = topicToAddress(transferLog.topics[1]);
    const transferTo = topicToAddress(transferLog.topics[2]);

    if (transferFrom !== expected.from) {
      reasons.push(
        `Transfer sender mismatch: expected ${expected.from}, got ${transferFrom ?? "<unreadable>"}.`,
      );
    }
    if (transferTo !== expected.to) {
      reasons.push(
        `Recipient mismatch: expected ${expected.to}, got ${transferTo ?? "<unreadable>"}. ` +
          `The payment did NOT go where it was requested.`,
      );
    }

    let value: bigint | null = null;
    try {
      value = BigInt(transferLog.data);
    } catch {
      value = null;
    }
    if (value === null) {
      reasons.push(`Transfer amount could not be decoded from log data "${transferLog.data}".`);
    } else if (value !== expected.amountWei) {
      reasons.push(
        `Amount mismatch: expected ${expected.amountWei} wei, transferred ${value} wei.`,
      );
    }
  }

  return {
    verified: reasons.length === 0,
    reasons,
    transferLogIndex: transferLog.logIndex,
    memoLogIndex: memoLog.logIndex,
  };
}

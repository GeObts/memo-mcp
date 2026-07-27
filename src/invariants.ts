/**
 * Write-path invariants, enforced server-side.
 *
 * The server can sign transactions, so it — not the calling agent, and not the
 * skill prompt — is the last line of defence. Every send must satisfy all
 * three invariants below, and there is deliberately no code path that signs
 * caller-supplied calldata:
 *
 *   1. chain is Base mainnet (8453)
 *   2. the call target is the configured token address, exactly
 *   3. the calldata is transferWithMemo(address,uint256,bytes32) and nothing else
 */
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const BASE_CHAIN_ID = 8453;

export const TRANSFER_WITH_MEMO_SIGNATURE =
  "transferWithMemo(address,uint256,bytes32)" as const;

/**
 * The ONLY function this server is able to encode a write for. Kept as a
 * one-entry ABI so there is no second write path to reach by accident.
 */
export const WRITE_ABI = parseAbi([
  "function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)",
]);

export const TRANSFER_WITH_MEMO_SELECTOR = toFunctionSelector(
  `function ${TRANSFER_WITH_MEMO_SIGNATURE}`,
);

/** Invariant 1: refuse to sign anything unless the RPC is really Base mainnet. */
export function assertBaseChain(chainId: number): void {
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(
      `Chain invariant: this server only signs on Base mainnet (chainId ${BASE_CHAIN_ID}), ` +
        `but the configured RPC reports chainId ${chainId}. Refusing to send. Check RPC_URL.`,
    );
  }
}

/**
 * Invariant 2: the write target must be the configured token.
 *
 * `requested` is optional so a caller can *confirm* which contract it believes
 * it is paying — but confirming a different address is an error, never a
 * redirect. There is no way to send to an unpinned token.
 */
export function assertTargetToken(
  requested: string | undefined,
  configured: Address,
): Address {
  const pinned = getAddress(configured);
  if (requested === undefined) return pinned;

  // isAddress is strict: a mixed-case address must carry a valid EIP-55
  // checksum. That is deliberate — the checksum is what catches a typo'd or
  // tampered address before it is paid.
  if (!isAddress(requested)) {
    throw new Error(
      `token "${requested}" is not a valid address, or its EIP-55 checksum does not match. ` +
        `Pass it exactly as the explorer shows it, or in all lowercase.`,
    );
  }
  const asked = getAddress(requested);
  if (asked !== pinned) {
    throw new Error(
      `Token invariant: send_memo is pinned to ${pinned} but was asked to write to ${asked}. ` +
        `Refusing to send. To use a different token, reconfigure MEMO_TOKEN_ADDRESS and restart the server.`,
    );
  }
  return pinned;
}

/** Validate and checksum a recipient address. */
export function assertRecipient(to: string): Address {
  if (typeof to !== "string" || !isAddress(to)) {
    throw new Error(
      `Recipient "${to}" is not a valid address, or its EIP-55 checksum does not match. ` +
        `Pass it exactly as the explorer shows it, or in all lowercase. ` +
        `A mistyped recipient means an unrecoverable payment, so this is not relaxed.`,
    );
  }
  const recipient = getAddress(to);
  if (recipient === "0x0000000000000000000000000000000000000000") {
    throw new Error("Refusing to send to the zero address — the payment would be unrecoverable.");
  }
  return recipient;
}

/**
 * Invariant 3: build the calldata ourselves and prove it is the expected call.
 *
 * The selector assertion is redundant given the one-entry ABI, and that is the
 * point: it fails loudly if the ABI is ever widened.
 */
export function buildTransferWithMemoCalldata(
  to: Address,
  amountWei: bigint,
  memoHex: Hex,
): Hex {
  if (amountWei <= 0n) {
    throw new Error(`Amount must be greater than zero, got ${amountWei} wei.`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(memoHex)) {
    throw new Error(`Memo must be a 32-byte hex word, got "${memoHex}".`);
  }

  const data = encodeFunctionData({
    abi: WRITE_ABI,
    functionName: "transferWithMemo",
    args: [to, amountWei, memoHex],
  });

  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== TRANSFER_WITH_MEMO_SELECTOR.toLowerCase()) {
    throw new Error(
      `Calldata invariant: encoded selector ${selector} is not ` +
        `${TRANSFER_WITH_MEMO_SELECTOR} (${TRANSFER_WITH_MEMO_SIGNATURE}). Refusing to send.`,
    );
  }
  // 4-byte selector + exactly three 32-byte words.
  if (data.length !== 2 + 8 + 64 * 3) {
    throw new Error(
      `Calldata invariant: expected ${TRANSFER_WITH_MEMO_SIGNATURE} to encode to 100 bytes, ` +
        `got ${(data.length - 2) / 2}. Refusing to send.`,
    );
  }

  return data;
}

/**
 * Configuration, loaded and validated once at boot.
 *
 * The spend caps are the only thing standing between a compromised or confused
 * agent and the signer's whole balance, so a server that can sign but has no
 * caps is a misconfiguration, not a default. loadConfig() refuses to return in
 * that case and the process exits — see the boot guard in index.ts.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { defaultLedgerPath } from "./ledger.js";
import { BASE_CHAIN_ID } from "./invariants.js";
import { DEFAULT_LOG_CHUNK_BLOCKS } from "./bounds.js";

/** $MEMO on Base mainnet. Human-readable view: https://memogram.pages.dev */
export const MEMO_DEFAULT_CA = "0xB20000000000000000000001BB894FF0C9e82bf3";
export const DEFAULT_RPC_URL = "https://mainnet.base.org";

export interface MemoConfig {
  rpcUrl: string;
  /** The pinned token. Sends to any other address are refused. */
  token: Address;
  /** Always Base mainnet; re-checked against the live RPC before each send. */
  expectedChainId: number;
  privateKey?: Hex;
  /** Whether this process is able to sign at all. */
  sendEnabled: boolean;
  /** Max token amount (human units) in a single send. Required when sending. */
  maxPerSend?: string;
  /** Max cumulative token amount (human units) across all runs. Required when sending. */
  maxTotal?: string;
  defaultFromBlock?: bigint;
  ledgerPath: string;
  /** Per-request eth_getLogs window; providers cap this independently of MAX_BLOCK_SPAN. */
  logChunkBlocks: bigint;
}

function requireDecimal(value: string, name: string): string {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new Error(`${name} must be a non-negative decimal number in token units, got "${value}".`);
  }
  if (Number(v) <= 0) {
    throw new Error(`${name} must be greater than zero, got "${value}". A zero cap disables sending entirely.`);
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MemoConfig {
  const rpcUrl = env.RPC_URL?.trim() || DEFAULT_RPC_URL;

  const rawToken = env.MEMO_TOKEN_ADDRESS?.trim() || MEMO_DEFAULT_CA;
  if (!isAddress(rawToken)) {
    throw new Error(`MEMO_TOKEN_ADDRESS "${rawToken}" is not a valid address.`);
  }
  const token = getAddress(rawToken);

  const rawKey = env.MEMO_PRIVATE_KEY?.trim();
  let privateKey: Hex | undefined;
  if (rawKey) {
    if (!isHex(rawKey) || rawKey.length !== 66) {
      throw new Error(
        "MEMO_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key. Refusing to boot.",
      );
    }
    privateKey = rawKey as Hex;
  }
  const sendEnabled = privateKey !== undefined;

  const rawPerSend = env.MEMO_MAX_PER_SEND?.trim();
  const rawTotal = env.MEMO_MAX_TOTAL?.trim();

  // Boot guard: a signer without caps is refused outright. (Read-only mode
  // cannot spend anything, so it does not require caps to be set.)
  if (sendEnabled) {
    const missing: string[] = [];
    if (!rawPerSend) missing.push("MEMO_MAX_PER_SEND");
    if (!rawTotal) missing.push("MEMO_MAX_TOTAL");
    if (missing.length > 0) {
      throw new Error(
        `Refusing to boot: MEMO_PRIVATE_KEY is set but ${missing.join(" and ")} ` +
          `${missing.length === 1 ? "is" : "are"} unset. A signer with no spend cap can be drained by a ` +
          `single bad call. Set both caps (in token units, e.g. MEMO_MAX_PER_SEND=10 MEMO_MAX_TOTAL=100), ` +
          `or unset MEMO_PRIVATE_KEY to run read-only.`,
      );
    }
  }

  const maxPerSend = rawPerSend ? requireDecimal(rawPerSend, "MEMO_MAX_PER_SEND") : undefined;
  const maxTotal = rawTotal ? requireDecimal(rawTotal, "MEMO_MAX_TOTAL") : undefined;

  if (maxPerSend && maxTotal && Number(maxPerSend) > Number(maxTotal)) {
    throw new Error(
      `Refusing to boot: MEMO_MAX_PER_SEND (${maxPerSend}) is greater than MEMO_MAX_TOTAL (${maxTotal}), ` +
        `so the per-send cap can never bind. Lower it to at most the total.`,
    );
  }

  let defaultFromBlock: bigint | undefined;
  const rawFromBlock = env.MEMO_FROM_BLOCK?.trim();
  if (rawFromBlock) {
    if (!/^\d+$/.test(rawFromBlock)) {
      throw new Error(`MEMO_FROM_BLOCK must be a non-negative integer, got "${rawFromBlock}".`);
    }
    defaultFromBlock = BigInt(rawFromBlock);
  }

  // Providers disagree on how wide an eth_getLogs window they will serve (the
  // public Base RPC allows 10,000; some tiers allow far less), so this is
  // tunable without touching the MAX_BLOCK_SPAN safety bound.
  let logChunkBlocks = DEFAULT_LOG_CHUNK_BLOCKS;
  const rawChunk = env.MEMO_LOG_CHUNK_BLOCKS?.trim();
  if (rawChunk) {
    if (!/^\d+$/.test(rawChunk) || BigInt(rawChunk) === 0n) {
      throw new Error(`MEMO_LOG_CHUNK_BLOCKS must be a positive integer, got "${rawChunk}".`);
    }
    logChunkBlocks = BigInt(rawChunk);
  }

  return {
    rpcUrl,
    token,
    expectedChainId: BASE_CHAIN_ID,
    privateKey,
    sendEnabled,
    maxPerSend,
    maxTotal,
    defaultFromBlock,
    ledgerPath: env.MEMO_SPEND_LEDGER?.trim() || defaultLedgerPath(),
    logChunkBlocks,
  };
}

/**
 * Bounds for read_memos.
 *
 * An agent reading memos can be induced — by a memo it just read, or by a
 * confused caller — into an unbounded log scan that is slow, expensive, or
 * silently truncated by the RPC. Both the result count and the block span are
 * therefore hard-capped, and going outside the bounds is an explicit error
 * rather than a silent clamp.
 */

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;
export const MAX_BLOCK_SPAN = 50_000n;

/**
 * How many blocks to ask an RPC for in a single eth_getLogs call.
 *
 * Independent of MAX_BLOCK_SPAN: providers impose their own window (the public
 * Base RPC rejects anything over 10,000, and some tiers are far stricter), so
 * a permitted 50,000-block range is served as several smaller requests rather
 * than one that the provider refuses.
 */
export const DEFAULT_LOG_CHUNK_BLOCKS = 10_000n;

/** Resolve and validate the result-count cap. Throws outside [1, MAX_LIMIT]. */
export function resolveLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) {
    throw new Error(`limit must be a whole number, got ${limit}.`);
  }
  if (limit < 1) {
    throw new Error(`limit must be at least 1, got ${limit}.`);
  }
  if (limit > MAX_LIMIT) {
    throw new Error(
      `limit ${limit} exceeds the maximum of ${MAX_LIMIT}. ` +
        `Request ${MAX_LIMIT} or fewer, and page with fromBlock/toBlock for more history.`,
    );
  }
  return limit;
}

export interface BlockRangeInput {
  fromBlock?: string;
  toBlock?: string;
  /** Current head, used as the default upper bound. */
  latest: bigint;
  /** MEMO_FROM_BLOCK, if configured. */
  defaultFromBlock?: bigint;
}

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
  span: bigint;
}

function parseBlock(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${field} must be a non-negative integer block number, got "${value}".`);
  }
  return BigInt(value.trim());
}

/**
 * Resolve fromBlock/toBlock into a validated range no wider than MAX_BLOCK_SPAN.
 *
 * Defaults to the most recent MAX_BLOCK_SPAN blocks. An explicit fromBlock with
 * no toBlock is capped at fromBlock + MAX_BLOCK_SPAN rather than running to the
 * head, so scanning old history is possible without ever widening the span.
 */
export function resolveBlockRange(input: BlockRangeInput): BlockRange {
  const { latest, defaultFromBlock } = input;

  const explicitFrom =
    input.fromBlock !== undefined ? parseBlock(input.fromBlock, "fromBlock") : undefined;
  const explicitTo =
    input.toBlock !== undefined ? parseBlock(input.toBlock, "toBlock") : undefined;

  if (explicitFrom !== undefined && explicitFrom > latest) {
    throw new Error(
      `fromBlock ${explicitFrom} is ahead of the chain head (${latest}). Nothing to scan.`,
    );
  }
  if (explicitTo !== undefined && explicitTo > latest) {
    throw new Error(
      `toBlock ${explicitTo} is ahead of the chain head (${latest}). Omit toBlock to scan to the head.`,
    );
  }

  let fromBlock: bigint;
  let toBlock: bigint;

  if (explicitFrom === undefined) {
    // No explicit start: scan the most recent window, anchored at the head.
    toBlock = explicitTo ?? latest;
    const preferred = defaultFromBlock ?? 0n;
    const windowStart = toBlock > MAX_BLOCK_SPAN ? toBlock - MAX_BLOCK_SPAN : 0n;
    fromBlock = preferred > windowStart ? preferred : windowStart;
  } else {
    fromBlock = explicitFrom;
    // An explicit start with no end walks forward a bounded window, so callers
    // can page through old history instead of being forced to the head.
    const capped = fromBlock + MAX_BLOCK_SPAN;
    toBlock = explicitTo ?? (capped < latest ? capped : latest);
  }

  if (toBlock < fromBlock) {
    throw new Error(`toBlock ${toBlock} is before fromBlock ${fromBlock}.`);
  }

  const span = toBlock - fromBlock;
  if (span > MAX_BLOCK_SPAN) {
    throw new Error(
      `Block range too wide: ${span} blocks (${fromBlock} to ${toBlock}), maximum is ${MAX_BLOCK_SPAN}. ` +
        `Narrow the range with fromBlock/toBlock and page through it.`,
    );
  }

  return { fromBlock, toBlock, span };
}

/**
 * Split a validated range into provider-sized windows, newest first.
 *
 * Newest first because callers want the most recent memos: the scan can stop
 * as soon as it has enough, instead of walking the whole range every time.
 */
export function chunkRangeNewestFirst(
  range: BlockRange,
  chunkSize: bigint = DEFAULT_LOG_CHUNK_BLOCKS,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (chunkSize <= 0n) throw new Error(`chunkSize must be positive, got ${chunkSize}.`);

  const chunks: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let to = range.toBlock;
  while (to >= range.fromBlock) {
    // chunkSize blocks inclusive of both ends.
    const tentativeFrom = to - (chunkSize - 1n);
    const from = tentativeFrom > range.fromBlock ? tentativeFrom : range.fromBlock;
    chunks.push({ fromBlock: from, toBlock: to });
    if (from === 0n || from <= range.fromBlock) break;
    to = from - 1n;
  }
  return chunks;
}

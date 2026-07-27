import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLimit,
  resolveBlockRange,
  chunkRangeNewestFirst,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_BLOCK_SPAN,
  DEFAULT_LOG_CHUNK_BLOCKS,
} from "../src/bounds.js";

const LATEST = 48_500_000n;

describe("resolveLimit", () => {
  test("defaults to 25", () => {
    assert.equal(resolveLimit(undefined), 25);
    assert.equal(DEFAULT_LIMIT, 25);
  });

  test("caps at 100", () => {
    assert.equal(MAX_LIMIT, 100);
    assert.equal(resolveLimit(100), 100);
  });

  test("throws above the cap rather than silently clamping", () => {
    assert.throws(() => resolveLimit(101), /exceeds the maximum of 100/);
    assert.throws(() => resolveLimit(100_000), /exceeds the maximum of 100/);
  });

  test("the error tells the caller how to page", () => {
    assert.throws(() => resolveLimit(500), /page with fromBlock\/toBlock/);
  });

  test("rejects zero and negatives", () => {
    assert.throws(() => resolveLimit(0), /at least 1/);
    assert.throws(() => resolveLimit(-5), /at least 1/);
  });

  test("rejects non-integers", () => {
    assert.throws(() => resolveLimit(2.5), /whole number/);
  });

  test("accepts the boundary values", () => {
    assert.equal(resolveLimit(1), 1);
    assert.equal(resolveLimit(99), 99);
  });
});

describe("resolveBlockRange", () => {
  test("max span is 50000", () => {
    assert.equal(MAX_BLOCK_SPAN, 50_000n);
  });

  test("with no arguments, scans the most recent 50000 blocks", () => {
    const r = resolveBlockRange({ latest: LATEST });
    assert.equal(r.toBlock, LATEST);
    assert.equal(r.fromBlock, LATEST - MAX_BLOCK_SPAN);
    assert.equal(r.span, MAX_BLOCK_SPAN);
  });

  test("an explicit fromBlock with no toBlock walks a bounded window forward", () => {
    const from = 48_000_000n;
    const r = resolveBlockRange({ fromBlock: from.toString(), latest: LATEST });
    assert.equal(r.fromBlock, from);
    assert.equal(r.toBlock, from + MAX_BLOCK_SPAN);
    assert.equal(r.span, MAX_BLOCK_SPAN);
  });

  test("a bounded window near the head stops at the head", () => {
    const from = LATEST - 10n;
    const r = resolveBlockRange({ fromBlock: from.toString(), latest: LATEST });
    assert.equal(r.toBlock, LATEST);
    assert.equal(r.span, 10n);
  });

  test("accepts an explicit range exactly at the cap", () => {
    const r = resolveBlockRange({
      fromBlock: "1000000",
      toBlock: (1_000_000n + MAX_BLOCK_SPAN).toString(),
      latest: LATEST,
    });
    assert.equal(r.span, MAX_BLOCK_SPAN);
  });

  test("throws one block over the cap", () => {
    assert.throws(
      () =>
        resolveBlockRange({
          fromBlock: "1000000",
          toBlock: (1_000_000n + MAX_BLOCK_SPAN + 1n).toString(),
          latest: LATEST,
        }),
      /Block range too wide: 50001 blocks/,
    );
  });

  test("throws on a hugely wide explicit range", () => {
    assert.throws(
      () => resolveBlockRange({ fromBlock: "1", toBlock: "48000000", latest: LATEST }),
      /Block range too wide/,
    );
  });

  test("the too-wide error names the maximum and suggests paging", () => {
    assert.throws(
      () => resolveBlockRange({ fromBlock: "1", toBlock: "48000000", latest: LATEST }),
      /maximum is 50000.*page through it/s,
    );
  });

  test("MEMO_FROM_BLOCK never widens the window past the cap", () => {
    // A deploy-block default far behind the head must not produce a huge scan.
    const r = resolveBlockRange({ latest: LATEST, defaultFromBlock: 1n });
    assert.equal(r.span, MAX_BLOCK_SPAN);
    assert.equal(r.fromBlock, LATEST - MAX_BLOCK_SPAN);
  });

  test("MEMO_FROM_BLOCK is honoured when it sits inside the window", () => {
    const preferred = LATEST - 100n;
    const r = resolveBlockRange({ latest: LATEST, defaultFromBlock: preferred });
    assert.equal(r.fromBlock, preferred);
    assert.equal(r.span, 100n);
  });

  test("rejects fromBlock ahead of the chain head", () => {
    assert.throws(
      () => resolveBlockRange({ fromBlock: (LATEST + 1n).toString(), latest: LATEST }),
      /ahead of the chain head/,
    );
  });

  test("rejects toBlock ahead of the chain head", () => {
    assert.throws(
      () => resolveBlockRange({ toBlock: (LATEST + 1n).toString(), latest: LATEST }),
      /ahead of the chain head/,
    );
  });

  test("rejects an inverted range", () => {
    assert.throws(
      () => resolveBlockRange({ fromBlock: "2000", toBlock: "1000", latest: LATEST }),
      /is before fromBlock/,
    );
  });

  test("rejects non-numeric block arguments", () => {
    assert.throws(
      () => resolveBlockRange({ fromBlock: "latest", latest: LATEST }),
      /non-negative integer block number/,
    );
    assert.throws(
      () => resolveBlockRange({ fromBlock: "-5", latest: LATEST }),
      /non-negative integer block number/,
    );
    assert.throws(
      () => resolveBlockRange({ fromBlock: "0x1234", latest: LATEST }),
      /non-negative integer block number/,
    );
  });

  test("handles an early chain where the head is below the span", () => {
    const r = resolveBlockRange({ latest: 100n });
    assert.equal(r.fromBlock, 0n);
    assert.equal(r.toBlock, 100n);
  });

  test("no resolved range ever exceeds the cap", () => {
    const cases = [
      { latest: LATEST },
      { latest: LATEST, defaultFromBlock: 0n },
      { fromBlock: "0", latest: LATEST },
      { fromBlock: "48000000", latest: LATEST },
      { toBlock: "1000000", latest: LATEST },
      { latest: 5n },
    ];
    for (const c of cases) {
      const label = `from=${c.fromBlock ?? "-"} to=${c.toBlock ?? "-"} latest=${c.latest} default=${c.defaultFromBlock ?? "-"}`;
      assert.ok(resolveBlockRange(c).span <= MAX_BLOCK_SPAN, `span too wide for ${label}`);
    }
  });
});

describe("chunkRangeNewestFirst", () => {
  // The safety bound (50000) and what a provider will actually serve in one
  // eth_getLogs call (10000 on the public Base RPC) are different numbers.
  test("the default chunk is smaller than the max span", () => {
    assert.equal(DEFAULT_LOG_CHUNK_BLOCKS, 10_000n);
    assert.ok(DEFAULT_LOG_CHUNK_BLOCKS < MAX_BLOCK_SPAN);
  });

  test("splits a full 50000-block span into provider-sized windows", () => {
    const range = resolveBlockRange({ latest: LATEST });
    // A span of 50000 is 50001 blocks inclusive, so it needs five full 10000-
    // block windows plus a one-block remainder.
    const chunks = chunkRangeNewestFirst(range);
    assert.equal(chunks.length, 6);
    for (const c of chunks) {
      assert.ok(
        c.toBlock - c.fromBlock + 1n <= DEFAULT_LOG_CHUNK_BLOCKS,
        "window wider than the RPC allows",
      );
    }
  });

  test("returns windows newest first, so a scan can stop early", () => {
    const chunks = chunkRangeNewestFirst(resolveBlockRange({ latest: LATEST }));
    assert.equal(chunks[0].toBlock, LATEST);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].toBlock < chunks[i - 1].fromBlock);
    }
  });

  test("covers the requested range exactly, with no gaps or overlaps", () => {
    const range = resolveBlockRange({ latest: LATEST });
    const chunks = chunkRangeNewestFirst(range);
    assert.equal(chunks[0].toBlock, range.toBlock);
    assert.equal(chunks[chunks.length - 1].fromBlock, range.fromBlock);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].toBlock + 1n, chunks[i - 1].fromBlock, "gap or overlap between windows");
    }
    const covered = chunks.reduce((n, c) => n + (c.toBlock - c.fromBlock + 1n), 0n);
    assert.equal(covered, range.span + 1n);
  });

  test("a range smaller than one chunk is a single window", () => {
    const chunks = chunkRangeNewestFirst({ fromBlock: 100n, toBlock: 200n, span: 100n });
    assert.deepEqual(chunks, [{ fromBlock: 100n, toBlock: 200n }]);
  });

  test("a single-block range is a single window", () => {
    const chunks = chunkRangeNewestFirst({ fromBlock: 500n, toBlock: 500n, span: 0n });
    assert.deepEqual(chunks, [{ fromBlock: 500n, toBlock: 500n }]);
  });

  test("honours a smaller provider window", () => {
    const chunks = chunkRangeNewestFirst({ fromBlock: 0n, toBlock: 99n, span: 99n }, 10n);
    assert.equal(chunks.length, 10);
    for (const c of chunks) assert.equal(c.toBlock - c.fromBlock, 9n);
    assert.equal(chunks[chunks.length - 1].fromBlock, 0n);
  });

  test("terminates on a range starting at block zero", () => {
    const chunks = chunkRangeNewestFirst({ fromBlock: 0n, toBlock: 25n, span: 25n }, 10n);
    assert.equal(chunks[chunks.length - 1].fromBlock, 0n);
    assert.ok(chunks.length <= 3);
  });

  test("rejects a non-positive chunk size", () => {
    assert.throws(
      () => chunkRangeNewestFirst({ fromBlock: 0n, toBlock: 10n, span: 10n }, 0n),
      /must be positive/,
    );
  });

  test("no window ever exceeds the configured chunk size", () => {
    for (const size of [1n, 7n, 1000n, 10_000n, 50_000n]) {
      const range = resolveBlockRange({ latest: LATEST });
      for (const c of chunkRangeNewestFirst(range, size)) {
        assert.ok(c.toBlock - c.fromBlock + 1n <= size, `window over ${size}`);
      }
    }
  });
});

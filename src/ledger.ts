/**
 * Persistent spend ledger.
 *
 * MEMO_MAX_TOTAL is only a real cap if it survives a restart — an in-memory
 * counter is reset by anything that can bounce the process, which turns the
 * "total" cap into a per-restart cap. Spend is therefore journalled to disk.
 *
 * Amounts are RESERVED before broadcast and only released if the transaction
 * is known to have reverted. An unknown outcome (timeout, RPC failure) stays
 * reserved: over-counting a spend is safe, under-counting is not.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Address } from "viem";

export const LEDGER_VERSION = 1;

export function defaultLedgerPath(): string {
  return join(homedir(), ".memo-mcp", "spend.json");
}

interface LedgerFile {
  version: number;
  /** token address (lowercase) -> cumulative wei spent */
  spent: Record<string, string>;
}

export interface SpendReservation {
  /** Drop the reservation — call ONLY when the send is known not to have moved funds. */
  release(): void;
}

export interface SpendLedger {
  path: string;
  /** Cumulative wei recorded against a token, across all runs. */
  spent(token: Address): bigint;
  /** Persist a reservation before broadcast. */
  reserve(token: Address, amountWei: bigint): SpendReservation;
}

function emptyFile(): LedgerFile {
  return { version: LEDGER_VERSION, spent: {} };
}

function read(path: string): LedgerFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return emptyFile(); // first run
    throw new Error(
      `Spend ledger at ${path} could not be read (${e?.message ?? e}). ` +
        `Refusing to send, because the MEMO_MAX_TOTAL cap cannot be enforced without it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Spend ledger at ${path} is corrupt (invalid JSON). Refusing to send — the ` +
        `MEMO_MAX_TOTAL cap cannot be enforced. Inspect it, then delete it to reset spend to zero.`,
    );
  }

  const file = parsed as LedgerFile;
  if (!file || typeof file !== "object" || file.version !== LEDGER_VERSION || typeof file.spent !== "object") {
    throw new Error(
      `Spend ledger at ${path} is not a version ${LEDGER_VERSION} ledger. Refusing to send.`,
    );
  }
  return { version: file.version, spent: { ...file.spent } };
}

function write(path: string, file: LedgerFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated ledger,
  // which would otherwise read as "nothing spent yet".
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function createLedger(path: string = defaultLedgerPath()): SpendLedger {
  const key = (token: Address) => token.toLowerCase();

  return {
    path,

    spent(token: Address): bigint {
      const file = read(path);
      const v = file.spent[key(token)];
      return v ? BigInt(v) : 0n;
    },

    reserve(token: Address, amountWei: bigint): SpendReservation {
      const file = read(path);
      const k = key(token);
      const prior = file.spent[k] ? BigInt(file.spent[k]) : 0n;
      file.spent[k] = (prior + amountWei).toString();
      write(path, file);

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const current = read(path);
          const now = current.spent[k] ? BigInt(current.spent[k]) : 0n;
          const next = now > amountWei ? now - amountWei : 0n;
          current.spent[k] = next.toString();
          write(path, current);
        },
      };
    },
  };
}

/** In-memory ledger, for tests. */
export function createMemoryLedger(): SpendLedger {
  const spent = new Map<string, bigint>();
  const key = (token: Address) => token.toLowerCase();

  return {
    path: "<memory>",
    spent: (token) => spent.get(key(token)) ?? 0n,
    reserve(token, amountWei) {
      const k = key(token);
      spent.set(k, (spent.get(k) ?? 0n) + amountWei);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const now = spent.get(k) ?? 0n;
          spent.set(k, now > amountWei ? now - amountWei : 0n);
        },
      };
    },
  };
}

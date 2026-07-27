/** Spend-cap arithmetic. Pure, so it can be tested without a chain or a wallet. */
import { formatUnits, parseUnits } from "viem";

export interface CapCheckInput {
  amountWei: bigint;
  decimals: number;
  /** Human units, from MEMO_MAX_PER_SEND. */
  maxPerSend: string;
  /** Human units, from MEMO_MAX_TOTAL. */
  maxTotal: string;
  /** Cumulative wei already spent on this token, across all runs. */
  spentWei: bigint;
}

export interface CapStatus {
  maxPerSendWei: bigint;
  maxTotalWei: bigint;
  spentWei: bigint;
  remainingWei: bigint;
}

export function capStatus(input: Omit<CapCheckInput, "amountWei">): CapStatus {
  const maxPerSendWei = parseUnits(input.maxPerSend, input.decimals);
  const maxTotalWei = parseUnits(input.maxTotal, input.decimals);
  const remainingWei = maxTotalWei > input.spentWei ? maxTotalWei - input.spentWei : 0n;
  return { maxPerSendWei, maxTotalWei, spentWei: input.spentWei, remainingWei };
}

/**
 * Throw if a send would breach either cap. Called before broadcast — a cap
 * that is only checked afterwards is not a cap.
 */
export function assertWithinCaps(input: CapCheckInput): CapStatus {
  const { amountWei, decimals } = input;
  const status = capStatus(input);
  const human = (wei: bigint) => formatUnits(wei, decimals);

  if (amountWei > status.maxPerSendWei) {
    throw new Error(
      `Spend cap: ${human(amountWei)} exceeds MEMO_MAX_PER_SEND=${input.maxPerSend}. Refusing to send.`,
    );
  }
  if (status.spentWei + amountWei > status.maxTotalWei) {
    throw new Error(
      `Spend cap: this send would exceed MEMO_MAX_TOTAL=${input.maxTotal}. ` +
        `Already spent ${human(status.spentWei)}, ${human(status.remainingWei)} remaining, ` +
        `requested ${human(amountWei)}. Refusing to send.`,
    );
  }

  return status;
}

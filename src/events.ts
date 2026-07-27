/** Shared B20 ABI fragments and event topics. */
import { parseAbi, parseAbiItem, toEventSelector } from "viem";

export const B20_ABI = parseAbi([
  "function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Memo(address indexed caller, bytes32 indexed memo)",
]);

export const MEMO_EVENT = parseAbiItem(
  "event Memo(address indexed caller, bytes32 indexed memo)",
);
export const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export const MEMO_TOPIC0 = toEventSelector(MEMO_EVENT);
export const TRANSFER_TOPIC0 = toEventSelector(TRANSFER_EVENT);

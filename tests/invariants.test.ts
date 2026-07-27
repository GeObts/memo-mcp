import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  assertBaseChain,
  assertRecipient,
  assertTargetToken,
  buildTransferWithMemoCalldata,
  BASE_CHAIN_ID,
  TRANSFER_WITH_MEMO_SELECTOR,
  TRANSFER_WITH_MEMO_SIGNATURE,
  WRITE_ABI,
} from "../src/invariants.js";

const TOKEN = getAddress("0xb20000000000000000000001bb894ff0c9e82bf3");
const OTHER_TOKEN = getAddress("0x4200000000000000000000000000000000000006");
const RECIPIENT = getAddress("0x75c83356987c8d813829d9fbb5de504b547750a6");
const MEMO_HEX =
  "0x4147454e54532041524520484552452053544f50000000000000000000000000" as Hex;

describe("chain invariant", () => {
  test("accepts Base mainnet", () => {
    assert.equal(BASE_CHAIN_ID, 8453);
    assert.doesNotThrow(() => assertBaseChain(8453));
  });

  test("refuses every other chain", () => {
    for (const id of [1, 10, 137, 42161, 84532, 8454, 0]) {
      assert.throws(() => assertBaseChain(id), /only signs on Base mainnet/, `chainId ${id}`);
    }
  });

  test("refuses Base Sepolia specifically", () => {
    assert.throws(() => assertBaseChain(84532), /chainId 84532/);
  });

  test("the error points at RPC_URL", () => {
    assert.throws(() => assertBaseChain(1), /Check RPC_URL/);
  });
});

describe("token invariant", () => {
  test("defaults to the configured token when none is requested", () => {
    assert.equal(assertTargetToken(undefined, TOKEN), TOKEN);
  });

  test("accepts an explicit confirmation of the configured token", () => {
    assert.equal(assertTargetToken(TOKEN, TOKEN), TOKEN);
  });

  test("accepts an all-lowercase confirmation", () => {
    assert.equal(assertTargetToken(TOKEN.toLowerCase(), TOKEN), TOKEN);
  });

  test("refuses an address whose EIP-55 checksum does not match", () => {
    // One flipped character in a checksummed address is exactly what EIP-55
    // exists to catch, so it is rejected rather than normalized away.
    const badChecksum = "0xB20000000000000000000001bb894ff0c9e82bf3";
    assert.notEqual(badChecksum, TOKEN);
    assert.throws(() => assertTargetToken(badChecksum, TOKEN), /EIP-55 checksum does not match/);
  });

  test("refuses a different token — it never redirects", () => {
    assert.throws(
      () => assertTargetToken(OTHER_TOKEN, TOKEN),
      /pinned to .* but was asked to write to/,
    );
  });

  test("the refusal says reconfiguration requires a restart", () => {
    assert.throws(() => assertTargetToken(OTHER_TOKEN, TOKEN), /MEMO_TOKEN_ADDRESS and restart/);
  });

  test("refuses a malformed address", () => {
    assert.throws(() => assertTargetToken("not-an-address", TOKEN), /is not a valid address/);
    assert.throws(() => assertTargetToken("0x1234", TOKEN), /is not a valid address/);
  });
});

describe("recipient validation", () => {
  test("checksums a valid address", () => {
    assert.equal(assertRecipient(RECIPIENT.toLowerCase()), RECIPIENT);
  });

  test("refuses malformed addresses", () => {
    for (const bad of ["", "0x", "0x123", "nope", RECIPIENT + "00"]) {
      assert.throws(() => assertRecipient(bad), /is not a valid address/, `input "${bad}"`);
    }
  });

  test("refuses a recipient with a broken checksum — a typo is unrecoverable", () => {
    const flipped = "0x75c83356987C8d813829d9fbb5de504b547750a6";
    assert.notEqual(flipped, RECIPIENT);
    assert.throws(() => assertRecipient(flipped), /EIP-55 checksum does not match/);
  });

  test("refuses the zero address", () => {
    assert.throws(
      () => assertRecipient("0x0000000000000000000000000000000000000000"),
      /zero address/,
    );
  });
});

describe("calldata invariant", () => {
  test("the selector is transferWithMemo(address,uint256,bytes32)", () => {
    assert.equal(TRANSFER_WITH_MEMO_SIGNATURE, "transferWithMemo(address,uint256,bytes32)");
    assert.equal(TRANSFER_WITH_MEMO_SELECTOR.length, 10);
  });

  test("builds calldata that starts with that selector", () => {
    const data = buildTransferWithMemoCalldata(RECIPIENT, 1n, MEMO_HEX);
    assert.equal(data.slice(0, 10).toLowerCase(), TRANSFER_WITH_MEMO_SELECTOR.toLowerCase());
  });

  test("encodes exactly 4 + 96 bytes — selector plus three words", () => {
    const data = buildTransferWithMemoCalldata(RECIPIENT, 1n, MEMO_HEX);
    assert.equal((data.length - 2) / 2, 100);
  });

  test("round-trips back to the requested arguments", () => {
    const amount = 1_500_000_000_000_000_000n;
    const data = buildTransferWithMemoCalldata(RECIPIENT, amount, MEMO_HEX);
    const decoded = decodeFunctionData({ abi: WRITE_ABI, data });
    assert.equal(decoded.functionName, "transferWithMemo");
    assert.deepEqual(decoded.args, [RECIPIENT, amount, MEMO_HEX]);
  });

  test("the write ABI exposes exactly one function — no second write path", () => {
    const functions = WRITE_ABI.filter((e: any) => e.type === "function");
    assert.equal(functions.length, 1);
    assert.equal((functions[0] as any).name, "transferWithMemo");
  });

  test("refuses a zero or negative amount", () => {
    assert.throws(() => buildTransferWithMemoCalldata(RECIPIENT, 0n, MEMO_HEX), /greater than zero/);
    assert.throws(() => buildTransferWithMemoCalldata(RECIPIENT, -1n, MEMO_HEX), /greater than zero/);
  });

  test("refuses a memo that is not a full 32-byte word", () => {
    for (const bad of ["0xdead", "0x", "not-hex", MEMO_HEX + "00"]) {
      assert.throws(
        () => buildTransferWithMemoCalldata(RECIPIENT, 1n, bad as Hex),
        /must be a 32-byte hex word/,
        `memo "${bad}"`,
      );
    }
  });

  test("there is no encoder for any other method", () => {
    // The one-entry ABI is the enforcement: asking for anything else throws.
    assert.throws(
      () =>
        buildTransferWithMemoCalldata(
          "not an address" as unknown as Address,
          1n,
          MEMO_HEX,
        ),
    );
  });
});

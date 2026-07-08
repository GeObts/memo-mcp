# memo-mcp

An MCP server that lets AI agents **attach on-chain memos to payments** on Base, using the native B20 memo feature. Built to make `$MEMO` the agent-native "pen" for chain memos.

## What it does

Wraps the B20 primitive:

```solidity
transferWithMemo(address to, uint256 amount, bytes32 memo)
event Memo(address indexed caller, bytes32 indexed memo)
```

The `Memo` event is emitted **immediately after** the `Transfer`, so any memo joins back to the payment it annotates via `logIndex - 1`. This server does that join for you.

## Tools

| Tool | Purpose |
|------|---------|
| `get_token_info` | name / symbol / decimals + the signer's balance |
| `send_memo` | send a payment with an attached memo (needs a key) |
| `read_memos` | read memos by `txHash`, or by `caller` over a block range — each joined to its payment (from / to / value) |

Memos are `bytes32`: pass up to 32 UTF-8 bytes of text, or a raw `0x…` bytes32.

## Setup

```bash
npm install
cp .env.example .env      # fill in MEMO_TOKEN_ADDRESS (your $MEMO), and a key for sending
npm run build
```

## Register with Claude Code

```bash
claude mcp add memo -- node /absolute/path/to/memo-mcp/dist/index.js
```

Or add to your MCP client config:

```json
{
  "mcpServers": {
    "memo": {
      "command": "node",
      "args": ["/absolute/path/to/memo-mcp/dist/index.js"],
      "env": {
        "RPC_URL": "https://mainnet.base.org",
        "MEMO_TOKEN_ADDRESS": "0xYOUR_MEMO_TOKEN",
        "MEMO_PRIVATE_KEY": "0xYOUR_KEY_FOR_SENDING"
      }
    }
  }
}
```

Leave `MEMO_PRIVATE_KEY` out for a read-only server.

## Example agent flow

1. `get_token_info` → confirm you hold `$MEMO`
2. `send_memo { to, amount: "1", memo: "gm from an agent" }` → returns tx hash + basescan link
3. `read_memos { caller: "0xYourAddr" }` → your memos, each joined to its payment

## Notes

- Public RPCs cap `getLogs` block ranges. For wide `caller` scans, set `MEMO_FROM_BLOCK` (e.g. the `$MEMO` deploy block) or pass `fromBlock`.
- `read_memos` by `txHash` is a single call and never hits range limits — prefer it when you have the hash.

# Percolator Locker

A Solana smart contract (Anchor program) that lets holders of the [$PERCOLATOR](https://percolatorlaunch.com) token lock their tokens for 30 days to earn trading fee discounts on the Percolator protocol.

## Why

The Percolator token has a fixed supply of ~989,290,880 — no minting, no inflation. Instead of emissions-based staking, token holders earn utility by locking: lock your tokens, qualify for a fee discount tier, and pay less when trading on the protocol.

## Fee Discount Tiers

| Tier | Min Lock Amount | Trading Fee Discount |
|------|----------------|---------------------|
| None | < 500,000 | 0% |
| Bronze | 500,000 | 10% off |
| Silver | 1,000,000 | 20% off |
| Gold | 5,000,000 | 30% off |

Lock the minimum amount and complete a 30-day lock cycle to start earning discount time. Lock more to reach a higher tier.

## How It Works

Every 30-day lock earns you 30 days of trading fee discount. The discount is always one cycle behind — you lock first, then receive the benefit.

1. Connect your wallet on the Percolator site
2. Choose how many tokens to lock
3. Tokens are transferred to the program's vault and locked for 30 days
4. After 30 days, your discount activates — re-lock to keep earning more discount time
5. If you stop re-locking, your earned discount still runs for 30 more days
6. To change your lock amount, withdraw and start a new lock (30-day wait resets)

## Build & Test

Requires [Anchor](https://www.anchor-lang.com/) and [Solana CLI](https://docs.solanalabs.com/cli/install).

```bash
anchor build
anchor test
```

## Ecosystem

- [percolatorlaunch.com](https://percolatorlaunch.com) — main site
- [GitHub](https://github.com/dcccrypto) — all Percolator repos

## License

MIT

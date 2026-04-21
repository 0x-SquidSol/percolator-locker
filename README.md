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

> Tier thresholds and the 30-day lock duration are vault parameters the admin can adjust over time within strict limits — see [Governance & Parameter Updates](#governance--parameter-updates). Any lock you already opened keeps the tier and cycle length it was created with, regardless of later adjustments.

## How It Works

Every 30-day lock earns you 30 days of trading fee discount. The discount is always one cycle behind — you lock first, then receive the benefit.

1. Connect your wallet on the Percolator site
2. Choose how many tokens to lock
3. Tokens are transferred to the program's vault and locked for 30 days
4. After 30 days, your discount activates — refresh your lock to keep earning more discount time
5. If you stop refreshing, your earned discount still runs for 30 more days
6. One lock per wallet per vault — after unlocking, that wallet's position for this vault is retired.

## Governance & Parameter Updates

The vault has an admin key that can adjust the three tier thresholds and the lock duration over time. The program constrains what the admin can do so the economy can't be reshaped out from under existing lockers:

- **Existing locks are immune.** When you lock, your tier and your cycle length are recorded on your position at that moment. Later changes to the vault's tier thresholds or lock duration do not retroactively re-classify your tier, extend your lock, or change when your earned discount ends. Admin changes only apply to locks opened after the change lands.
- **Changes are rate-limited.** The admin must wait at least 7 days between successful config updates on the vault.
- **Each change is bounded.** In any single update, no parameter (any of the three tier thresholds or the lock duration) can move by more than 50% of its current value. Reaching a very different value takes multiple updates spaced across multiple cooldown windows, giving users and integrators time to observe and react.
- **Ordering is preserved.** Bronze must remain below Silver, which must remain below Gold, and the lock duration stays within the program's allowed range.

The vault's custody fields (token mint, vault token account, admin pubkey, locker count, total locked) are never touched by a configuration update.

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

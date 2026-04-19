import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PercolatorLocker } from "../target/types/percolator_locker";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";

describe("percolator-locker", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PercolatorLocker as Program<PercolatorLocker>;
  const connection = provider.connection;

  // --- Constants that mirror the on-chain handler's validation bounds ---
  const MIN_LOCK_DURATION = 86_400; // 1 day in seconds
  const MAX_LOCK_DURATION = 31_536_000; // 1 year in seconds
  const DEFAULT_LOCK_DURATION = 2_592_000; // 30 days
  const DEFAULT_BRONZE = 500_000;
  const DEFAULT_SILVER = 1_000_000;
  const DEFAULT_GOLD = 5_000_000;
  const DECIMALS = 6;

  // --- Helper functions ---

  /** Airdrop SOL to a wallet for transaction fees and rent */
  async function airdrop(to: PublicKey, amount = 10 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(to, amount);
    await connection.confirmTransaction(sig, "confirmed");
  }

  /** Create a new SPL token mint */
  async function createTestMint(
    authority: Keypair,
    decimals = DECIMALS
  ): Promise<PublicKey> {
    return await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );
  }

  /** Create a token account for a given mint and owner */
  async function createTestTokenAccount(
    payer: Keypair,
    mint: PublicKey,
    owner: PublicKey
  ): Promise<PublicKey> {
    return await createAccount(connection, payer, mint, owner);
  }

  /** Mint tokens to a token account */
  async function mintTestTokens(
    authority: Keypair,
    mint: PublicKey,
    destination: PublicKey,
    amount: number | bigint
  ): Promise<void> {
    await mintTo(connection, authority, mint, destination, authority, amount);
  }

  /** Derive the vault PDA from an admin public key */
  function deriveVaultPda(admin: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lock_vault"), admin.toBuffer()],
      program.programId
    );
  }

  /** Derive the lock position PDA from a vault and user */
  function deriveLockPositionPda(
    vault: PublicKey,
    user: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lock_position"), vault.toBuffer(), user.toBuffer()],
      program.programId
    );
  }

  /** Create a funded admin keypair and a fresh test mint. Used as the starting fixture for most tests. */
  async function setupAdmin(): Promise<{ admin: Keypair; mint: PublicKey }> {
    const admin = Keypair.generate();
    await airdrop(admin.publicKey);
    const mint = await createTestMint(admin);
    return { admin, mint };
  }

  /**
   * Call initialize_vault with the given admin and mint. All four numeric args default to valid
   * values; tests override only the field they want to probe. Returns the derived vault PDA and
   * the freshly-created vault token account pubkey so tests can fetch on-chain state.
   */
  async function initVault(
    admin: Keypair,
    mint: PublicKey,
    opts: {
      lockDuration?: number;
      bronze?: number;
      silver?: number;
      gold?: number;
    } = {}
  ) {
    const vaultTokenAccountKp = Keypair.generate();
    const [vaultPda, bump] = deriveVaultPda(admin.publicKey);
    const lockDuration = opts.lockDuration ?? DEFAULT_LOCK_DURATION;
    const bronze = opts.bronze ?? DEFAULT_BRONZE;
    const silver = opts.silver ?? DEFAULT_SILVER;
    const gold = opts.gold ?? DEFAULT_GOLD;

    await program.methods
      .initializeVault(
        new BN(lockDuration),
        new BN(bronze),
        new BN(silver),
        new BN(gold)
      )
      .accountsStrict({
        admin: admin.publicKey,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountKp.publicKey,
        tokenMint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin, vaultTokenAccountKp])
      .rpc();

    return {
      vaultPda,
      bump,
      vaultTokenAccount: vaultTokenAccountKp.publicKey,
    };
  }

  /**
   * Create a funded user keypair with a token account that already holds `amount` of the mint.
   * `mintAuthority` is the keypair that owns mint authority (typically the admin keypair from setupAdmin).
   */
  async function setupUser(
    mint: PublicKey,
    mintAuthority: Keypair,
    amount: number | bigint = 20_000_000
  ): Promise<{ user: Keypair; userTokenAccount: PublicKey }> {
    const user = Keypair.generate();
    await airdrop(user.publicKey);
    const userTokenAccount = await createAccount(
      connection,
      mintAuthority,
      mint,
      user.publicKey,
      undefined,
      { commitment: "confirmed" }
    );
    await mintTo(
      connection,
      mintAuthority,
      mint,
      userTokenAccount,
      mintAuthority,
      amount,
      [],
      { commitment: "confirmed" }
    );
    return { user, userTokenAccount };
  }

  /**
   * Call the `lock` instruction with explicit accounts and the user signer. Returns the
   * derived LockPosition PDA so tests can fetch it afterwards.
   */
  async function lockTokens(opts: {
    user: Keypair;
    vault: PublicKey;
    vaultTokenAccount: PublicKey;
    userTokenAccount: PublicKey;
    mint: PublicKey;
    amount: number | BN;
  }): Promise<PublicKey> {
    const [lockPositionPda] = deriveLockPositionPda(
      opts.vault,
      opts.user.publicKey
    );
    const amountBn =
      opts.amount instanceof BN ? opts.amount : new BN(opts.amount);
    await program.methods
      .lock(amountBn)
      .accountsStrict({
        user: opts.user.publicKey,
        vault: opts.vault,
        lockPosition: lockPositionPda,
        userTokenAccount: opts.userTokenAccount,
        vaultTokenAccount: opts.vaultTokenAccount,
        tokenMint: opts.mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([opts.user])
      .rpc({ commitment: "confirmed" });
    return lockPositionPda;
  }

  describe("initialize_vault", () => {
    it("creates a vault with valid inputs", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, bump, vaultTokenAccount } = await initVault(
        admin,
        mint
      );

      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.ok(vault.admin.equals(admin.publicKey), "admin mismatch");
      assert.ok(vault.tokenMint.equals(mint), "token_mint mismatch");
      assert.ok(
        vault.vaultTokenAccount.equals(vaultTokenAccount),
        "vault_token_account mismatch"
      );
      assert.strictEqual(
        vault.lockDuration.toNumber(),
        DEFAULT_LOCK_DURATION,
        "lock_duration mismatch"
      );
      assert.strictEqual(
        vault.tierBronze.toNumber(),
        DEFAULT_BRONZE,
        "tier_bronze mismatch"
      );
      assert.strictEqual(
        vault.tierSilver.toNumber(),
        DEFAULT_SILVER,
        "tier_silver mismatch"
      );
      assert.strictEqual(
        vault.tierGold.toNumber(),
        DEFAULT_GOLD,
        "tier_gold mismatch"
      );
      assert.strictEqual(vault.totalLocked.toNumber(), 0);
      assert.strictEqual(vault.totalLockers.toNumber(), 0);
      assert.strictEqual(vault.tokenDecimals, DECIMALS);
      assert.strictEqual(vault.bump, bump);

      const tokenAccount = await getAccount(connection, vaultTokenAccount);
      assert.ok(
        tokenAccount.mint.equals(mint),
        "vault token account mint mismatch"
      );
      assert.ok(
        tokenAccount.owner.equals(vaultPda),
        "vault token account authority should be the vault PDA"
      );
      assert.strictEqual(
        tokenAccount.amount,
        0n,
        "vault token account should have zero balance"
      );
    });

    it("rejects a second init for the same admin", async () => {
      const { admin, mint } = await setupAdmin();
      await initVault(admin, mint);

      try {
        await initVault(admin, mint);
        assert.fail("expected second initialize_vault to fail but it succeeded");
      } catch (err: any) {
        // Anchor's `init` constraint fails at the system level when the PDA already exists:
        // a SendTransactionError whose log line contains "already in use".
        const msg = err?.toString?.() ?? String(err);
        assert.match(
          msg,
          /already in use|already initialized/i,
          `unexpected error: ${msg}`
        );
      }
    });

    it("accepts lock_duration = MIN_LOCK_DURATION (inclusive lower bound)", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda } = await initVault(admin, mint, {
        lockDuration: MIN_LOCK_DURATION,
      });
      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.strictEqual(vault.lockDuration.toNumber(), MIN_LOCK_DURATION);
    });

    it("accepts lock_duration = MAX_LOCK_DURATION (inclusive upper bound)", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda } = await initVault(admin, mint, {
        lockDuration: MAX_LOCK_DURATION,
      });
      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.strictEqual(vault.lockDuration.toNumber(), MAX_LOCK_DURATION);
    });

    it("rejects lock_duration = MIN_LOCK_DURATION - 1 (just below bound)", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, {
          lockDuration: MIN_LOCK_DURATION - 1,
        });
        assert.fail("expected LockDurationTooShort");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "LockDurationTooShort",
          `expected LockDurationTooShort, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects lock_duration = 0 (below minimum)", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, { lockDuration: 0 });
        assert.fail("expected LockDurationTooShort");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "LockDurationTooShort",
          `expected LockDurationTooShort, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects lock_duration above 1 year (above maximum)", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, {
          lockDuration: MAX_LOCK_DURATION + 1,
        });
        assert.fail("expected LockDurationTooLong");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "LockDurationTooLong",
          `expected LockDurationTooLong, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects tier_bronze = 0", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, {
          bronze: 0,
          silver: DEFAULT_SILVER,
          gold: DEFAULT_GOLD,
        });
        assert.fail("expected InvalidTierThresholds");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "InvalidTierThresholds",
          `expected InvalidTierThresholds, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects tier_silver equal to tier_bronze (not strictly ascending)", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, {
          bronze: DEFAULT_SILVER,
          silver: DEFAULT_SILVER,
          gold: DEFAULT_GOLD,
        });
        assert.fail("expected InvalidTierThresholds");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "InvalidTierThresholds",
          `expected InvalidTierThresholds, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects tier_gold equal to tier_silver (not strictly ascending)", async () => {
      const { admin, mint } = await setupAdmin();
      try {
        await initVault(admin, mint, {
          bronze: DEFAULT_BRONZE,
          silver: DEFAULT_SILVER,
          gold: DEFAULT_SILVER,
        });
        assert.fail("expected InvalidTierThresholds");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "InvalidTierThresholds",
          `expected InvalidTierThresholds, got: ${err?.toString?.() ?? err}`
        );
      }
    });
  });

  describe("lock", () => {
    it("locks tokens at the Bronze threshold with full state assertions", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      const { user, userTokenAccount } = await setupUser(mint, admin);
      const amount = DEFAULT_BRONZE;

      const userBefore = await getAccount(
        connection,
        userTokenAccount,
        "confirmed"
      );
      const vaultTaBefore = await getAccount(
        connection,
        vaultTokenAccount,
        "confirmed"
      );

      // Listen for the Locked event emitted by the handler
      const eventPromise = new Promise<any>((resolve) => {
        const listener = program.addEventListener("locked", (event) => {
          program.removeEventListener(listener);
          resolve(event);
        });
        setTimeout(() => resolve(null), 5000);
      });

      const preTxTime = Math.floor(Date.now() / 1000);
      const lockPositionPda = await lockTokens({
        user,
        vault: vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint,
        amount,
      });
      const postTxTime = Math.floor(Date.now() / 1000);
      const emittedEvent = await eventPromise;

      // Token balances moved
      const userAfter = await getAccount(
        connection,
        userTokenAccount,
        "confirmed"
      );
      const vaultTaAfter = await getAccount(
        connection,
        vaultTokenAccount,
        "confirmed"
      );
      assert.strictEqual(
        Number(userAfter.amount),
        Number(userBefore.amount) - amount,
        "user token balance did not decrease by amount"
      );
      assert.strictEqual(
        Number(vaultTaAfter.amount),
        Number(vaultTaBefore.amount) + amount,
        "vault token account balance did not increase by amount"
      );

      // LockPosition fields all populated correctly
      const position = await program.account.lockPosition.fetch(lockPositionPda);
      const [, expectedBump] = deriveLockPositionPda(vaultPda, user.publicKey);
      assert.ok(position.owner.equals(user.publicKey), "owner mismatch");
      assert.ok(position.vault.equals(vaultPda), "vault mismatch");
      assert.strictEqual(position.amount.toNumber(), amount, "amount mismatch");
      assert.ok(
        position.lockStart.toNumber() >= preTxTime - 2 &&
          position.lockStart.toNumber() <= postTxTime + 2,
        `lock_start ${position.lockStart.toNumber()} not within [${preTxTime - 2}, ${postTxTime + 2}]`
      );
      assert.strictEqual(
        position.lockEnd.toNumber(),
        position.lockStart.toNumber() + DEFAULT_LOCK_DURATION,
        "lock_end should be lock_start + lock_duration"
      );
      assert.strictEqual(
        position.discountEnd.toNumber(),
        position.lockEnd.toNumber() + DEFAULT_LOCK_DURATION,
        "discount_end should be lock_end + lock_duration"
      );
      assert.deepStrictEqual(position.tier, { bronze: {} }, "tier should be Bronze");
      assert.strictEqual(position.isActive, true, "is_active should be true");
      assert.strictEqual(position.bump, expectedBump, "bump mismatch");
      assert.strictEqual(
        position.cycleDuration.toNumber(),
        DEFAULT_LOCK_DURATION,
        "cycle_duration should be snapshotted from vault.lock_duration at lock time"
      );

      // Vault counters incremented
      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.strictEqual(vault.totalLocked.toNumber(), amount, "total_locked mismatch");
      assert.strictEqual(vault.totalLockers.toNumber(), 1, "total_lockers mismatch");

      // Locked event emitted with matching fields
      assert.ok(emittedEvent !== null, "Locked event was not emitted");
      assert.ok(
        emittedEvent.user.equals(user.publicKey),
        "event.user mismatch"
      );
      assert.ok(emittedEvent.vault.equals(vaultPda), "event.vault mismatch");
      assert.strictEqual(
        emittedEvent.amount.toNumber(),
        amount,
        "event.amount mismatch"
      );
      assert.deepStrictEqual(
        emittedEvent.tier,
        { bronze: {} },
        "event.tier mismatch"
      );
      assert.strictEqual(
        emittedEvent.lockStart.toNumber(),
        position.lockStart.toNumber(),
        "event.lock_start mismatch"
      );
      assert.strictEqual(
        emittedEvent.lockEnd.toNumber(),
        position.lockEnd.toNumber(),
        "event.lock_end mismatch"
      );
      assert.strictEqual(
        emittedEvent.discountEnd.toNumber(),
        position.discountEnd.toNumber(),
        "event.discount_end mismatch"
      );
      assert.strictEqual(
        emittedEvent.cycleDuration.toNumber(),
        DEFAULT_LOCK_DURATION,
        "event.cycle_duration mismatch"
      );
    });

    // Walk every edge in the calculate_tier if-else ladder
    const TIER_CASES: Array<{
      amount: number;
      expectedTier: "bronze" | "silver" | "gold";
      label: string;
    }> = [
      { amount: 750_000, expectedTier: "bronze", label: "between Bronze and Silver" },
      { amount: DEFAULT_SILVER, expectedTier: "silver", label: "exactly Silver" },
      { amount: 2_500_000, expectedTier: "silver", label: "between Silver and Gold" },
      { amount: DEFAULT_GOLD, expectedTier: "gold", label: "exactly Gold" },
      { amount: DEFAULT_GOLD * 2, expectedTier: "gold", label: "above Gold" },
    ];

    for (const { amount, expectedTier, label } of TIER_CASES) {
      it(`classifies ${amount.toLocaleString()} as ${expectedTier} (${label})`, async () => {
        const { admin, mint } = await setupAdmin();
        const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
        const { user, userTokenAccount } = await setupUser(mint, admin);
        const lockPositionPda = await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount,
          mint,
          amount,
        });
        const position = await program.account.lockPosition.fetch(lockPositionPda);
        assert.deepStrictEqual(position.tier, { [expectedTier]: {} });
        assert.strictEqual(position.amount.toNumber(), amount);
      });
    }

    it("accumulates total_locked and total_lockers across multiple users", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      const { user: userA, userTokenAccount: taA } = await setupUser(mint, admin);
      const { user: userB, userTokenAccount: taB } = await setupUser(mint, admin);

      const amountA = DEFAULT_BRONZE;
      const amountB = DEFAULT_SILVER;

      await lockTokens({
        user: userA,
        vault: vaultPda,
        vaultTokenAccount,
        userTokenAccount: taA,
        mint,
        amount: amountA,
      });
      await lockTokens({
        user: userB,
        vault: vaultPda,
        vaultTokenAccount,
        userTokenAccount: taB,
        mint,
        amount: amountB,
      });

      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.strictEqual(
        vault.totalLocked.toNumber(),
        amountA + amountB,
        "total_locked should be the sum of both locks"
      );
      assert.strictEqual(
        vault.totalLockers.toNumber(),
        2,
        "total_lockers should be 2"
      );
    });

    it("rejects amount = 0 (InvalidAmount)", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      const { user, userTokenAccount } = await setupUser(mint, admin);
      try {
        await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount,
          mint,
          amount: 0,
        });
        assert.fail("expected InvalidAmount");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "InvalidAmount",
          `expected InvalidAmount, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects amount below Bronze threshold (BelowMinimumTier)", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      const { user, userTokenAccount } = await setupUser(mint, admin);
      try {
        await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount,
          mint,
          amount: DEFAULT_BRONZE - 1,
        });
        assert.fail("expected BelowMinimumTier");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "BelowMinimumTier",
          `expected BelowMinimumTier, got: ${err?.toString?.() ?? err}`
        );
      }
    });

    it("rejects a second lock while the user already has an active position", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      const { user, userTokenAccount } = await setupUser(mint, admin);

      // First lock succeeds
      const firstAmount = DEFAULT_BRONZE;
      const lockPositionPda = await lockTokens({
        user,
        vault: vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint,
        amount: firstAmount,
      });

      // Second lock attempt against the same (vault, user) PDA must fail — the
      // `init` constraint rejects at the system level when the account exists.
      try {
        await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount,
          mint,
          amount: 750_000,
        });
        assert.fail("expected second lock to fail");
      } catch (err: any) {
        const msg = err?.toString?.() ?? String(err);
        assert.match(
          msg,
          /already in use|already initialized/i,
          `unexpected error: ${msg}`
        );
      }

      // Verify the first lock's state was not clobbered by the failed second attempt
      const position = await program.account.lockPosition.fetch(lockPositionPda);
      assert.strictEqual(
        position.amount.toNumber(),
        firstAmount,
        "original lock amount should be unchanged after failed second lock"
      );
      assert.strictEqual(
        position.isActive,
        true,
        "original lock should still be active"
      );
    });

    it("rejects locking more tokens than the user's wallet holds", async () => {
      const { admin, mint } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mint);
      // User gets a balance just above the Bronze threshold so we can lock a
      // valid-on-paper amount (passes the BelowMinimumTier check) that exceeds balance
      const walletBalance = 600_000;
      const { user, userTokenAccount } = await setupUser(
        mint,
        admin,
        walletBalance
      );

      try {
        await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount,
          mint,
          amount: walletBalance + 100_000,
        });
        assert.fail("expected insufficient-funds failure");
      } catch (err: any) {
        const msg =
          (err?.toString?.() ?? String(err)) +
          " " +
          (err?.logs?.join(" ") ?? "");
        assert.match(
          msg,
          /insufficient funds|0x1\b/i,
          `unexpected error: ${msg}`
        );
      }

      // Atomic rollback: vault state should be untouched by the failed lock
      const vault = await program.account.lockVault.fetch(vaultPda);
      assert.strictEqual(vault.totalLocked.toNumber(), 0);
      assert.strictEqual(vault.totalLockers.toNumber(), 0);
      const vaultTa = await getAccount(
        connection,
        vaultTokenAccount,
        "confirmed"
      );
      assert.strictEqual(
        Number(vaultTa.amount),
        0,
        "vault token account should not have received anything"
      );
    });

    it("rejects locking with a token account for the wrong mint (ConstraintTokenMint)", async () => {
      const { admin, mint: mintA } = await setupAdmin();
      const { vaultPda, vaultTokenAccount } = await initVault(admin, mintA);

      // A second, unrelated mint (same mint authority for test convenience)
      const mintB = await createTestMint(admin);
      const { user, userTokenAccount: mintBTokenAccount } = await setupUser(
        mintB,
        admin
      );

      // Pass the vault's mint (mintA) as `tokenMint` to satisfy the vault's has_one,
      // but the user's token account is for mintB — the `token::mint = token_mint`
      // constraint on user_token_account must fire.
      try {
        await lockTokens({
          user,
          vault: vaultPda,
          vaultTokenAccount,
          userTokenAccount: mintBTokenAccount,
          mint: mintA,
          amount: DEFAULT_BRONZE,
        });
        assert.fail("expected ConstraintTokenMint");
      } catch (err: any) {
        assert.strictEqual(
          err.error?.errorCode?.code,
          "ConstraintTokenMint",
          `expected ConstraintTokenMint, got: ${err?.toString?.() ?? err}`
        );
      }
    });
  });
});

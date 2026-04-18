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
});

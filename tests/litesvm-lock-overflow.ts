import { BN, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import { LiteSVMProvider } from "anchor-litesvm";
import { assert } from "chai";
import { makeHarness } from "../test-helpers/litesvm";
import { PercolatorLocker } from "../target/types/percolator_locker";

const LOCK_VAULT_SEED = Buffer.from("lock_vault");
const LOCK_POSITION_SEED = Buffer.from("lock_position");
const DEFAULT_LOCK_DURATION = 2_592_000;
const DEFAULT_BRONZE = 500_000;
const DEFAULT_SILVER = 1_000_000;
const DEFAULT_GOLD = 5_000_000;
const DECIMALS = 6;
const USER_STARTING_BALANCE = 20_000_000;

// u64::MAX. Javascript BigInt literal is exact — Anchor's BN takes the decimal
// string and round-trips through the lockVault Borsh layout without loss.
const U64_MAX = "18446744073709551615";

/**
 * Pathological-state tests for the `checked_add` guards in the `lock` handler.
 *
 * Normal program inputs cannot reach these overflow branches: total_locked
 * would need to sit at u64::MAX - amount before the call, and total_lockers
 * would need to sit at u64::MAX — neither is producible from valid lock/unlock
 * sequences against any sane PERCOLATOR supply. The tests seed the required
 * vault state directly via the Anchor coder round-trip (same pattern used in
 * litesvm-refresh-lock.ts and litesvm-update-config.ts) so that a refactor
 * swapping `checked_add` for `saturating_add` or `wrapping_add` would be
 * caught — saturating would silently cap the counter at u64::MAX and a later
 * unlock's `checked_sub` could then underflow; wrapping would roll the
 * counter to 0 and permanently desynchronize the aggregate from reality.
 */
describe("lock overflow guards (litesvm)", () => {
  // === Setup helpers ===
  // Duplicated from litesvm-update-config.ts and friends on purpose; extraction
  // into a shared test-helpers module is tracked as a follow-up refactor commit.

  function setupAdmin(svm: LiteSVM): Keypair {
    const admin = Keypair.generate();
    svm.airdrop(admin.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    return admin;
  }

  async function createTestMint(
    svm: LiteSVM,
    provider: LiteSVMProvider,
    admin: Keypair
  ): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const rent = svm.getRent().minimumBalance(BigInt(MINT_SIZE));
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mintKp.publicKey,
        lamports: Number(rent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        mintKp.publicKey,
        DECIMALS,
        admin.publicKey,
        null
      )
    );
    await provider.sendAndConfirm!(tx, [admin, mintKp]);
    return mintKp.publicKey;
  }

  async function setupUser(
    svm: LiteSVM,
    provider: LiteSVMProvider,
    mint: PublicKey,
    mintAuthority: Keypair,
    amount: number | bigint
  ): Promise<{ user: Keypair; userTokenAccount: PublicKey }> {
    const user = Keypair.generate();
    svm.airdrop(user.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

    const tokenAccountKp = Keypair.generate();
    const rent = svm.getRent().minimumBalance(BigInt(ACCOUNT_SIZE));
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: mintAuthority.publicKey,
        newAccountPubkey: tokenAccountKp.publicKey,
        lamports: Number(rent),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        tokenAccountKp.publicKey,
        mint,
        user.publicKey
      ),
      createMintToInstruction(
        mint,
        tokenAccountKp.publicKey,
        mintAuthority.publicKey,
        amount
      )
    );
    await provider.sendAndConfirm!(tx, [mintAuthority, tokenAccountKp]);

    return { user, userTokenAccount: tokenAccountKp.publicKey };
  }

  async function initVault(
    program: Program<PercolatorLocker>,
    admin: Keypair,
    mint: PublicKey
  ): Promise<{ vaultPda: PublicKey; vaultTokenAccount: PublicKey }> {
    const vaultTokenAccountKp = Keypair.generate();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [LOCK_VAULT_SEED, admin.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .initializeVault(
        new BN(DEFAULT_LOCK_DURATION),
        new BN(DEFAULT_BRONZE),
        new BN(DEFAULT_SILVER),
        new BN(DEFAULT_GOLD)
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
    return { vaultPda, vaultTokenAccount: vaultTokenAccountKp.publicKey };
  }

  async function lockTokens(
    program: Program<PercolatorLocker>,
    user: Keypair,
    vault: PublicKey,
    vaultTokenAccount: PublicKey,
    userTokenAccount: PublicKey,
    mint: PublicKey,
    amount: number | BN
  ): Promise<PublicKey> {
    const [lockPositionPda] = PublicKey.findProgramAddressSync(
      [LOCK_POSITION_SEED, vault.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
    const amountBn = amount instanceof BN ? amount : new BN(amount);
    await program.methods
      .lock(amountBn)
      .accountsStrict({
        user: user.publicKey,
        vault,
        lockPosition: lockPositionPda,
        userTokenAccount,
        vaultTokenAccount,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    return lockPositionPda;
  }

  // Round-trip the vault's on-chain bytes through Anchor's coder to simulate
  // a state the program cannot natively produce. Preserves discriminator,
  // lamports, and owner.
  async function setVaultState(
    svm: LiteSVM,
    program: Program<PercolatorLocker>,
    vaultPda: PublicKey,
    mutate: (vault: any) => void
  ): Promise<void> {
    const vaultAccount = svm.getAccount(vaultPda)!;
    const decoded = program.coder.accounts.decode(
      "lockVault",
      Buffer.from(vaultAccount.data)
    );
    mutate(decoded);
    const reencoded = await program.coder.accounts.encode(
      "lockVault",
      decoded
    );
    svm.setAccount(vaultPda, {
      lamports: vaultAccount.lamports,
      data: new Uint8Array(reencoded),
      owner: vaultAccount.owner,
      executable: false,
    });
  }

  // === Tests ===

  it("rejects lock when total_locked + amount would overflow u64", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(program, admin, mint);
    const { user, userTokenAccount } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );

    // Seed total_locked so that a valid Bronze-tier lock would push it
    // exactly one unit past u64::MAX: total_locked = u64::MAX - (BRONZE - 1),
    // user locks BRONZE, sum = u64::MAX + 1 → checked_add returns None.
    await setVaultState(svm, program, vaultPda, (v) => {
      v.totalLocked = new BN(U64_MAX).sub(new BN(DEFAULT_BRONZE - 1));
    });

    try {
      await lockTokens(
        program,
        user,
        vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint,
        DEFAULT_BRONZE
      );
      assert.fail("expected ArithmeticOverflow on total_locked overflow");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ArithmeticOverflow",
        `expected ArithmeticOverflow, got: ${err.error?.errorCode?.code ?? err.message}`
      );
    }
  });

  it("rejects lock when total_lockers + 1 would overflow u64", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(program, admin, mint);
    const { user, userTokenAccount } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );

    // Seed total_lockers at u64::MAX so the `+1` increment overflows.
    // total_locked is left untouched (0) so the earlier checked_add on
    // `total_locked + amount` does not short-circuit this test.
    await setVaultState(svm, program, vaultPda, (v) => {
      v.totalLockers = new BN(U64_MAX);
    });

    try {
      await lockTokens(
        program,
        user,
        vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint,
        DEFAULT_BRONZE
      );
      assert.fail("expected ArithmeticOverflow on total_lockers overflow");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ArithmeticOverflow",
        `expected ArithmeticOverflow, got: ${err.error?.errorCode?.code ?? err.message}`
      );
    }
  });
});

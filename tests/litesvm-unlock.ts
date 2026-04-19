import { BN, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  getAccount,
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
import { makeHarness, warpTo } from "../test-helpers/litesvm";
import { PercolatorLocker } from "../target/types/percolator_locker";

const LOCK_VAULT_SEED = Buffer.from("lock_vault");
const LOCK_POSITION_SEED = Buffer.from("lock_position");
const DEFAULT_LOCK_DURATION = 2_592_000; // 30 days in seconds
const DEFAULT_BRONZE = 500_000;
const DEFAULT_SILVER = 1_000_000;
const DEFAULT_GOLD = 5_000_000;
const DECIMALS = 6;
const USER_STARTING_BALANCE = 20_000_000;

describe("unlock (litesvm)", () => {
  // === Setup helpers ===
  // Kept inline on first touch; promote to test-helpers/litesvm.ts when the
  // refresh_lock tests land and want the same plumbing.

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

  async function unlockTokens(
    program: Program<PercolatorLocker>,
    owner: Keypair,
    vault: PublicKey,
    vaultTokenAccount: PublicKey,
    userTokenAccount: PublicKey,
    mint: PublicKey
  ): Promise<PublicKey> {
    const [lockPositionPda] = PublicKey.findProgramAddressSync(
      [LOCK_POSITION_SEED, vault.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .unlock()
      .accountsStrict({
        owner: owner.publicKey,
        vault,
        lockPosition: lockPositionPda,
        userTokenAccount,
        vaultTokenAccount,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    return lockPositionPda;
  }

  // === Tests ===

  it("unlocks after the lock window elapses, preserving tier and discount_end", async () => {
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

    // Lock at exactly Bronze
    const amount = DEFAULT_BRONZE;
    const lockPositionPda = await lockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint,
      amount
    );

    // Snapshot pre-unlock state
    const userTaBefore = await getAccount(
      provider.connection,
      userTokenAccount
    );
    const vaultTaBefore = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const positionBefore = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultBefore = await program.account.lockVault.fetch(vaultPda);

    // Advance the clock past lock_end. lock_start was ~now-at-lock-time (clock
    // auto-advances between ops), lock_end = lock_start + DEFAULT_LOCK_DURATION.
    // Jump to lock_end + 1 so the handler's `now >= lock_end` guard passes.
    warpTo(svm, BigInt(positionBefore.lockEnd.toNumber() + 1));

    // Unlock
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    // Snapshot post-unlock state
    const userTaAfter = await getAccount(
      provider.connection,
      userTokenAccount
    );
    const vaultTaAfter = await getAccount(
      provider.connection,
      vaultTokenAccount
    );
    const positionAfter = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultAfter = await program.account.lockVault.fetch(vaultPda);

    // --- Token balances: exactly `amount` moved back to the user ---
    assert.strictEqual(
      userTaAfter.amount - userTaBefore.amount,
      BigInt(amount),
      "user token balance should increase by exactly the locked amount"
    );
    assert.strictEqual(
      vaultTaBefore.amount - vaultTaAfter.amount,
      BigInt(amount),
      "vault token balance should decrease by exactly the locked amount"
    );

    // --- LockPosition: retired but preserved ---
    assert.strictEqual(
      positionAfter.amount.toNumber(),
      0,
      "position amount should be zeroed"
    );
    assert.strictEqual(
      positionAfter.isActive,
      false,
      "position should be retired"
    );
    assert.deepStrictEqual(
      positionAfter.tier,
      positionBefore.tier,
      "tier must be preserved for matcher"
    );
    assert.strictEqual(
      positionAfter.discountEnd.toNumber(),
      positionBefore.discountEnd.toNumber(),
      "discount_end must be preserved for matcher"
    );
    assert.ok(
      positionAfter.owner.equals(positionBefore.owner),
      "owner preserved"
    );
    assert.ok(
      positionAfter.vault.equals(positionBefore.vault),
      "vault preserved"
    );
    assert.strictEqual(
      positionAfter.lockStart.toNumber(),
      positionBefore.lockStart.toNumber(),
      "lock_start preserved"
    );
    assert.strictEqual(
      positionAfter.lockEnd.toNumber(),
      positionBefore.lockEnd.toNumber(),
      "lock_end preserved"
    );
    assert.strictEqual(
      positionAfter.bump,
      positionBefore.bump,
      "bump preserved"
    );
    assert.strictEqual(
      positionAfter.cycleDuration.toNumber(),
      positionBefore.cycleDuration.toNumber(),
      "cycle_duration preserved"
    );

    // --- Earned-discount runway is still non-empty right after unlock ---
    const nowAfter = Number(svm.getClock().unixTimestamp);
    assert.ok(
      positionAfter.discountEnd.toNumber() > nowAfter,
      "discount_end should be in the future at unlock time (earned discount runway)"
    );

    // --- Vault counters decremented ---
    assert.strictEqual(
      vaultBefore.totalLocked.toNumber() - vaultAfter.totalLocked.toNumber(),
      amount,
      "total_locked should decrement by exactly the unlocked amount"
    );
    assert.strictEqual(
      vaultBefore.totalLockers.toNumber() - vaultAfter.totalLockers.toNumber(),
      1,
      "total_lockers should decrement by 1"
    );

    // --- Non-counter vault fields unchanged ---
    assert.ok(vaultAfter.admin.equals(vaultBefore.admin));
    assert.ok(vaultAfter.tokenMint.equals(vaultBefore.tokenMint));
    assert.ok(
      vaultAfter.vaultTokenAccount.equals(vaultBefore.vaultTokenAccount)
    );
    assert.strictEqual(
      vaultAfter.lockDuration.toNumber(),
      vaultBefore.lockDuration.toNumber()
    );
    assert.strictEqual(
      vaultAfter.tierBronze.toNumber(),
      vaultBefore.tierBronze.toNumber()
    );
    assert.strictEqual(
      vaultAfter.tierSilver.toNumber(),
      vaultBefore.tierSilver.toNumber()
    );
    assert.strictEqual(
      vaultAfter.tierGold.toNumber(),
      vaultBefore.tierGold.toNumber()
    );
    assert.strictEqual(
      vaultAfter.tokenDecimals,
      vaultBefore.tokenDecimals
    );
    assert.strictEqual(vaultAfter.bump, vaultBefore.bump);
  });

  it("decrements counters only for the unlocking user, leaving the other position untouched", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(program, admin, mint);

    // User A locks Bronze, user B locks Silver.
    const { user: userA, userTokenAccount: taA } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );
    const { user: userB, userTokenAccount: taB } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );

    const amountA = DEFAULT_BRONZE;
    const amountB = DEFAULT_SILVER;

    const positionAPda = await lockTokens(
      program,
      userA,
      vaultPda,
      vaultTokenAccount,
      taA,
      mint,
      amountA
    );
    const positionBPda = await lockTokens(
      program,
      userB,
      vaultPda,
      vaultTokenAccount,
      taB,
      mint,
      amountB
    );

    // Snapshot B's position AND token balance before A unlocks, so we can
    // assert A's unlock doesn't contaminate B's state or move B's tokens.
    const positionBBefore = await program.account.lockPosition.fetch(
      positionBPda
    );
    const taBBefore = await getAccount(provider.connection, taB);

    // Warp past A's lock_end.
    const positionA = await program.account.lockPosition.fetch(positionAPda);
    warpTo(svm, BigInt(positionA.lockEnd.toNumber() + 1));

    await unlockTokens(
      program,
      userA,
      vaultPda,
      vaultTokenAccount,
      taA,
      mint
    );

    // Vault counters reflect only A's withdrawal.
    const vaultAfter = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(
      vaultAfter.totalLocked.toNumber(),
      amountB,
      "total_locked should equal only B's amount after A unlocks"
    );
    assert.strictEqual(
      vaultAfter.totalLockers.toNumber(),
      1,
      "total_lockers should be 1 after one of two users unlocks"
    );

    // B's position is completely untouched.
    const positionBAfter = await program.account.lockPosition.fetch(
      positionBPda
    );
    assert.strictEqual(
      positionBAfter.amount.toNumber(),
      positionBBefore.amount.toNumber(),
      "user B's amount unchanged"
    );
    assert.strictEqual(
      positionBAfter.isActive,
      true,
      "user B's position still active"
    );
    assert.deepStrictEqual(
      positionBAfter.tier,
      positionBBefore.tier,
      "user B's tier unchanged"
    );
    assert.strictEqual(
      positionBAfter.lockEnd.toNumber(),
      positionBBefore.lockEnd.toNumber(),
      "user B's lock_end unchanged"
    );
    assert.strictEqual(
      positionBAfter.discountEnd.toNumber(),
      positionBBefore.discountEnd.toNumber(),
      "user B's discount_end unchanged"
    );
    assert.strictEqual(
      positionBAfter.cycleDuration.toNumber(),
      positionBBefore.cycleDuration.toNumber(),
      "user B's cycle_duration unchanged"
    );

    // B's token balance hasn't moved either — A's unlock must not transfer
    // from any account other than the vault's.
    const taBAfter = await getAccount(provider.connection, taB);
    assert.strictEqual(
      taBAfter.amount,
      taBBefore.amount,
      "user B's token balance unchanged"
    );
  });

  // === Rejection tests ===

  it("rejects unlock before the lock window elapses (LockNotExpired)", async () => {
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

    // Lock, but do NOT warp the clock. The handler's `now >= lock_end` guard
    // should reject an immediate unlock attempt.
    await lockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint,
      DEFAULT_BRONZE
    );

    try {
      await unlockTokens(
        program,
        user,
        vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint
      );
      assert.fail("expected LockNotExpired");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "LockNotExpired",
        `expected LockNotExpired, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects unlock of someone else's position (ConstraintSeeds)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(program, admin, mint);

    // User A locks; user B is a funded non-locker who will try to steal.
    const { user: userA, userTokenAccount: taA } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );
    const { user: userB, userTokenAccount: taB } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );

    const aLockPositionPda = await lockTokens(
      program,
      userA,
      vaultPda,
      vaultTokenAccount,
      taA,
      mint,
      DEFAULT_BRONZE
    );

    // Warp past A's lock_end so the time guard can't be the failure reason —
    // we want to isolate the wrong-owner failure mode specifically.
    const positionA = await program.account.lockPosition.fetch(aLockPositionPda);
    warpTo(svm, BigInt(positionA.lockEnd.toNumber() + 1));

    // B attempts unlock passing A's lock_position PDA as `lockPosition`.
    // Anchor derives the expected PDA from [LOCK_POSITION_SEED, vault, B.key]
    // (owner = B in the accounts struct) and compares against the passed
    // pubkey — mismatch fires ConstraintSeeds BEFORE the handler runs.
    try {
      await program.methods
        .unlock()
        .accountsStrict({
          owner: userB.publicKey,
          vault: vaultPda,
          lockPosition: aLockPositionPda,
          userTokenAccount: taB,
          vaultTokenAccount,
          tokenMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();
      assert.fail("expected ConstraintSeeds");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConstraintSeeds",
        `expected ConstraintSeeds, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a second unlock on an already-inactive position (PositionNotActive)", async () => {
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

    const lockPositionPda = await lockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint,
      DEFAULT_BRONZE
    );

    // Warp past lock_end and unlock successfully.
    const positionBefore = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    warpTo(svm, BigInt(positionBefore.lockEnd.toNumber() + 1));
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    // Confirm the first unlock actually succeeded before attempting the
    // second — prevents misleading failure attribution if the first unlock
    // silently regressed.
    const positionMid = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionMid.isActive,
      false,
      "first unlock should flip is_active to false"
    );
    assert.strictEqual(
      positionMid.amount.toNumber(),
      0,
      "first unlock should zero the amount"
    );

    // Force a fresh blockhash before the second unlock. Without this,
    // LiteSVM reuses the same blockhash, producing a duplicate tx signature
    // that Solana's runtime rejects BEFORE executing the program — the
    // assertion would then see a generic SendTransactionError with no logs
    // instead of the expected AnchorError.
    svm.expireBlockhash();

    // Second unlock: seeds still match (owner, vault, bump unchanged),
    // has_one still matches, account deserializes — so the handler runs
    // and the `require!(is_active)` guard fires.
    try {
      await unlockTokens(
        program,
        user,
        vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint
      );
      assert.fail("expected PositionNotActive");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "PositionNotActive",
        `expected PositionNotActive, got: ${err?.toString?.() ?? err}`
      );
    }
  });
});

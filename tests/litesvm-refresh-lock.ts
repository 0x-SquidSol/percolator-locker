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

describe("refresh_lock (litesvm)", () => {
  // === Setup helpers ===
  // Duplicated from litesvm-unlock.ts on purpose; the extraction into a shared
  // test-helpers module is tracked as a follow-up refactor commit. Keeping them
  // inline here keeps this commit scoped to "add refresh_lock tests" alone.

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
  ): Promise<void> {
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
  }

  async function refreshLock(
    program: Program<PercolatorLocker>,
    owner: Keypair,
    vault: PublicKey
  ): Promise<void> {
    const [lockPositionPda] = PublicKey.findProgramAddressSync(
      [LOCK_POSITION_SEED, vault.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .refreshLock()
      .accountsStrict({
        owner: owner.publicKey,
        vault,
        lockPosition: lockPositionPda,
      })
      .signers([owner])
      .rpc();
  }

  // === Tests ===

  it("advances lock_end and discount_end by cycle_duration on an on-time refresh", async () => {
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
    const positionBefore = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultBefore = await program.account.lockVault.fetch(vaultPda);

    // Warp to exactly lock_end — the inclusive boundary the `now >= lock_end`
    // guard is meant to accept. Doubles as a boundary test for the guard.
    warpTo(svm, BigInt(positionBefore.lockEnd.toNumber()));
    const nowAtRefresh = Number(svm.getClock().unixTimestamp);

    await refreshLock(program, user, vaultPda);

    const positionAfter = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultAfter = await program.account.lockVault.fetch(vaultPda);

    // --- Timestamps advanced correctly ---
    assert.strictEqual(
      positionAfter.lockEnd.toNumber(),
      nowAtRefresh + DEFAULT_LOCK_DURATION,
      "lock_end should be reset to now + cycle_duration"
    );
    assert.strictEqual(
      positionAfter.discountEnd.toNumber(),
      positionBefore.discountEnd.toNumber() + DEFAULT_LOCK_DURATION,
      "discount_end should be extended by cycle_duration"
    );

    // --- Earned-discount runway remains non-empty after refresh ---
    assert.ok(
      positionAfter.discountEnd.toNumber() > positionAfter.lockEnd.toNumber(),
      "discount_end must remain strictly greater than lock_end"
    );

    // --- Everything else on the position is untouched ---
    assert.ok(
      positionAfter.owner.equals(positionBefore.owner),
      "owner preserved"
    );
    assert.ok(
      positionAfter.vault.equals(positionBefore.vault),
      "vault preserved"
    );
    assert.strictEqual(
      positionAfter.amount.toNumber(),
      positionBefore.amount.toNumber(),
      "amount preserved (refresh is not a transfer)"
    );
    assert.deepStrictEqual(
      positionAfter.tier,
      positionBefore.tier,
      "tier preserved — not re-evaluated on refresh"
    );
    assert.strictEqual(
      positionAfter.isActive,
      true,
      "is_active stays true"
    );
    assert.strictEqual(
      positionAfter.lockStart.toNumber(),
      positionBefore.lockStart.toNumber(),
      "lock_start pinned to the original lock timestamp"
    );
    assert.strictEqual(
      positionAfter.bump,
      positionBefore.bump,
      "bump preserved"
    );
    assert.strictEqual(
      positionAfter.cycleDuration.toNumber(),
      positionBefore.cycleDuration.toNumber(),
      "cycle_duration preserved — snapshot is write-once at lock time"
    );

    // --- Vault counters untouched — the user was locked before and is still
    // locked after, just for another cycle. ---
    assert.strictEqual(
      vaultAfter.totalLocked.toNumber(),
      vaultBefore.totalLocked.toNumber(),
      "total_locked unchanged"
    );
    assert.strictEqual(
      vaultAfter.totalLockers.toNumber(),
      vaultBefore.totalLockers.toNumber(),
      "total_lockers unchanged"
    );
    // Sanity — admin/mint/bump/thresholds never move under refresh.
    assert.ok(vaultAfter.admin.equals(vaultBefore.admin));
    assert.strictEqual(
      vaultAfter.lockDuration.toNumber(),
      vaultBefore.lockDuration.toNumber()
    );
  });

  it("stacks discount_end by cycle_duration on each successive refresh", async () => {
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
    const positionAtLock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const originalDiscountEnd = positionAtLock.discountEnd.toNumber();

    // First refresh at exactly lock_end.
    warpTo(svm, BigInt(positionAtLock.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, user, vaultPda);
    const positionAfter1 = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionAfter1.discountEnd.toNumber(),
      originalDiscountEnd + DEFAULT_LOCK_DURATION,
      "discount_end should grow by one cycle after first refresh"
    );

    // Second refresh at the NEW lock_end. Fresh blockhash avoids the
    // duplicate-tx-signature rejection path that would mask the handler
    // result with an opaque validator error.
    warpTo(svm, BigInt(positionAfter1.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, user, vaultPda);
    const positionAfter2 = await program.account.lockPosition.fetch(
      lockPositionPda
    );

    assert.strictEqual(
      positionAfter2.discountEnd.toNumber(),
      originalDiscountEnd + 2 * DEFAULT_LOCK_DURATION,
      "discount_end should grow by two cycles after two refreshes"
    );
    // Amount, tier, and cycle_duration never move across refreshes.
    assert.strictEqual(
      positionAfter2.amount.toNumber(),
      positionAtLock.amount.toNumber()
    );
    assert.deepStrictEqual(positionAfter2.tier, positionAtLock.tier);
    assert.strictEqual(
      positionAfter2.cycleDuration.toNumber(),
      positionAtLock.cycleDuration.toNumber()
    );
  });

  it("advances by the position's cycle_duration snapshot, ignoring a later vault.lock_duration change", async () => {
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
    const positionAtLock = await program.account.lockPosition.fetch(
      lockPositionPda
    );

    // Simulate a future `update_config` that tripled vault.lock_duration by
    // rewriting the vault account's bytes directly. This is impossible on a
    // real validator (no current handler mutates lock_duration), but that's
    // the point: we're proving refresh would NOT use the vault's value even
    // if it were somehow different from the position's snapshot. The Anchor
    // coder round-trips the account so all other vault fields stay intact.
    const VAULT_LOCK_DURATION_INFLATED = DEFAULT_LOCK_DURATION * 3;
    const vaultBytes = svm.getAccount(vaultPda)!;
    const decoded = program.coder.accounts.decode(
      "lockVault",
      Buffer.from(vaultBytes.data)
    );
    decoded.lockDuration = new BN(VAULT_LOCK_DURATION_INFLATED);
    const reencoded = await program.coder.accounts.encode("lockVault", decoded);
    svm.setAccount(vaultPda, {
      lamports: vaultBytes.lamports,
      data: new Uint8Array(reencoded),
      owner: vaultBytes.owner,
      executable: false,
    });

    // Sanity-check the mutation landed.
    const vaultMutated = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(
      vaultMutated.lockDuration.toNumber(),
      VAULT_LOCK_DURATION_INFLATED,
      "vault.lock_duration should reflect the simulated admin bump"
    );
    // The position's cycle_duration should NOT have moved.
    const positionBeforeRefresh = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionBeforeRefresh.cycleDuration.toNumber(),
      DEFAULT_LOCK_DURATION,
      "position cycle_duration is write-once — vault rewrite does not touch it"
    );

    // Warp to the position's lock_end and refresh.
    warpTo(svm, BigInt(positionBeforeRefresh.lockEnd.toNumber()));
    const nowAtRefresh = Number(svm.getClock().unixTimestamp);
    await refreshLock(program, user, vaultPda);

    const positionAfter = await program.account.lockPosition.fetch(
      lockPositionPda
    );

    // The handler must have used the POSITION's cycle_duration (DEFAULT), not
    // the vault's new lock_duration (3x DEFAULT). If it had read the vault,
    // both lock_end and discount_end would have advanced by 3 cycles.
    assert.strictEqual(
      positionAfter.lockEnd.toNumber(),
      nowAtRefresh + DEFAULT_LOCK_DURATION,
      "refresh advanced lock_end by the position's snapshotted cycle_duration"
    );
    assert.strictEqual(
      positionAfter.discountEnd.toNumber(),
      positionAtLock.discountEnd.toNumber() + DEFAULT_LOCK_DURATION,
      "refresh advanced discount_end by the position's snapshotted cycle_duration"
    );
    assert.notStrictEqual(
      positionAfter.lockEnd.toNumber(),
      nowAtRefresh + VAULT_LOCK_DURATION_INFLATED,
      "refresh MUST NOT have used the vault's inflated lock_duration"
    );
  });

  it("rejects refresh before the current cycle has elapsed (LockNotExpired)", async () => {
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

    await lockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint,
      DEFAULT_BRONZE
    );

    // No warp — clock is ~lock_start, handler's `now >= lock_end` guard must
    // reject.
    try {
      await refreshLock(program, user, vaultPda);
      assert.fail("expected LockNotExpired");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "LockNotExpired",
        `expected LockNotExpired, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects refresh of an already-unlocked position (PositionNotActive)", async () => {
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
    const position = await program.account.lockPosition.fetch(lockPositionPda);

    // Warp to lock_end + 1 so unlock can run cleanly, then unlock (retires
    // the position) and try to refresh it.
    warpTo(svm, BigInt(position.lockEnd.toNumber() + 1));
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    // Fresh blockhash — the unlock call just used one, and refresh's
    // transaction would otherwise inherit identical signers (blocking it at
    // the runtime layer with an opaque SendTransactionError before Anchor
    // can surface the handler-guard error we want to assert on).
    svm.expireBlockhash();

    try {
      await refreshLock(program, user, vaultPda);
      assert.fail("expected PositionNotActive");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "PositionNotActive",
        `expected PositionNotActive, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects refresh of someone else's position (ConstraintSeeds)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(program, admin, mint);

    const { user: userA, userTokenAccount: taA } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );
    const { user: userB } = await setupUser(
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
    const positionA = await program.account.lockPosition.fetch(aLockPositionPda);
    warpTo(svm, BigInt(positionA.lockEnd.toNumber()));

    // B signs a refresh and passes A's position PDA. Anchor re-derives
    // the expected PDA from [LOCK_POSITION_SEED, vault, B.key] and the
    // mismatch fires ConstraintSeeds BEFORE the handler runs — B's key
    // is NOT the stored owner of A's position.
    try {
      await program.methods
        .refreshLock()
        .accountsStrict({
          owner: userB.publicKey,
          vault: vaultPda,
          lockPosition: aLockPositionPda,
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

  it("rejects refresh after the earned-discount window has lapsed (DiscountLapsed)", async () => {
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
    const position = await program.account.lockPosition.fetch(lockPositionPda);

    // Warp past discount_end — the user procrastinated past the end of their
    // earned window. `now >= lock_end` passes; `now < discount_end` fails.
    warpTo(svm, BigInt(position.discountEnd.toNumber() + 1));

    try {
      await refreshLock(program, user, vaultPda);
      assert.fail("expected DiscountLapsed");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "DiscountLapsed",
        `expected DiscountLapsed, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects refresh at exactly discount_end (DiscountLapsed boundary)", async () => {
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
    const position = await program.account.lockPosition.fetch(lockPositionPda);

    // Warp to exactly `discount_end`. The handler's guard is `now < discount_end`
    // (strict), so at the boundary the refresh must reject — a non-strict `<=`
    // would let this case through, leaving `new_discount_end == new_lock_end`
    // and zero earned-discount runway after the refresh. This test pins the
    // strictness of the guard against that mutation.
    warpTo(svm, BigInt(position.discountEnd.toNumber()));

    try {
      await refreshLock(program, user, vaultPda);
      assert.fail("expected DiscountLapsed");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "DiscountLapsed",
        `expected DiscountLapsed, got: ${err?.toString?.() ?? err}`
      );
    }
  });
});

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

/**
 * End-to-end lifecycle tests. Every prior LiteSVM suite exercises one
 * instruction in isolation; these tests chain multiple instructions and
 * verify the earned-discount model's math holds across every state
 * transition — the property the README's user flow depends on.
 *
 * Scope:
 * - Continuous locker (lock + multiple refreshes + unlock) — tier and
 *   discount_end must advance linearly across every refresh and survive
 *   the terminal unlock.
 * - Early unlock rejected then eventually succeeds — proves a failed tx
 *   leaves vault + position state byte-identical so the legitimate unlock
 *   after the cycle elapses is unaffected.
 * - Lock → refresh → unlock — the shortest cross-instruction path that
 *   still verifies refresh's new timestamps carry through to unlock.
 */
describe("lifecycle (litesvm)", () => {
  // === Setup helpers ===
  // Duplicated from prior LiteSVM test files; extraction into a shared
  // test-helpers module is a tracked follow-up refactor.

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

  it("continuous locker: lock + 3 refreshes + unlock advances discount_end linearly", async () => {
    // Mirrors the README's "continuous locker" flow. After a lock and N
    // on-time refreshes, the earned-discount runway is (N+1) * cycle_duration
    // past the original lock_start, and the terminal unlock preserves that
    // runway so the matcher can still read `discount_end > now`.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
    const { user, userTokenAccount } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );

    // Lock at T0.
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
    const lockStart = positionAtLock.lockStart.toNumber();

    // After lock: lock_end = lockStart + cycle, discount_end = lockStart + 2*cycle.
    assert.strictEqual(
      positionAtLock.lockEnd.toNumber(),
      lockStart + DEFAULT_LOCK_DURATION,
      "initial lock_end should be lock_start + cycle_duration"
    );
    assert.strictEqual(
      positionAtLock.discountEnd.toNumber(),
      lockStart + 2 * DEFAULT_LOCK_DURATION,
      "initial discount_end should be lock_start + 2 * cycle_duration"
    );

    // Refresh N=3 times, each time at the just-written lock_end.
    for (let cycle = 1; cycle <= 3; cycle++) {
      const positionBeforeRefresh =
        await program.account.lockPosition.fetch(lockPositionPda);
      warpTo(svm, BigInt(positionBeforeRefresh.lockEnd.toNumber()));
      svm.expireBlockhash();
      await refreshLock(program, user, vaultPda);

      const positionAfterRefresh =
        await program.account.lockPosition.fetch(lockPositionPda);
      // After refresh N: lock_end = lock_start + (N+1)*cycle,
      //                  discount_end = lock_start + (N+2)*cycle.
      assert.strictEqual(
        positionAfterRefresh.lockEnd.toNumber(),
        lockStart + (cycle + 1) * DEFAULT_LOCK_DURATION,
        `after refresh #${cycle}: lock_end should be lock_start + ${cycle + 1} cycles`
      );
      assert.strictEqual(
        positionAfterRefresh.discountEnd.toNumber(),
        lockStart + (cycle + 2) * DEFAULT_LOCK_DURATION,
        `after refresh #${cycle}: discount_end should be lock_start + ${cycle + 2} cycles`
      );
      // lock_start never moves.
      assert.strictEqual(
        positionAfterRefresh.lockStart.toNumber(),
        lockStart,
        "lock_start is immutable across refreshes"
      );
      // tier, amount, cycle_duration all preserved.
      assert.deepStrictEqual(
        positionAfterRefresh.tier,
        positionAtLock.tier,
        "tier preserved across refresh"
      );
      assert.strictEqual(
        positionAfterRefresh.amount.toNumber(),
        positionAtLock.amount.toNumber(),
        "amount preserved across refresh (refresh is not a transfer)"
      );
      assert.strictEqual(
        positionAfterRefresh.cycleDuration.toNumber(),
        positionAtLock.cycleDuration.toNumber(),
        "cycle_duration snapshot preserved across refresh"
      );
      assert.strictEqual(
        positionAfterRefresh.isActive,
        true,
        "position stays active across refresh"
      );
    }

    // Terminal unlock at the final lock_end (lock_start + 4*cycle).
    const positionBeforeUnlock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    warpTo(svm, BigInt(positionBeforeUnlock.lockEnd.toNumber()));
    svm.expireBlockhash();
    const userTaBeforeUnlock = await getAccount(
      provider.connection,
      userTokenAccount
    );
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );
    const positionAfterUnlock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const userTaAfterUnlock = await getAccount(
      provider.connection,
      userTokenAccount
    );

    // Tokens are back with the user.
    assert.strictEqual(
      userTaAfterUnlock.amount - userTaBeforeUnlock.amount,
      BigInt(DEFAULT_BRONZE),
      "tokens returned to user on terminal unlock"
    );

    // Position is retired but discount_end is preserved at the value written
    // during the final refresh (lock_start + 5*cycle).
    assert.strictEqual(
      positionAfterUnlock.isActive,
      false,
      "position retired after terminal unlock"
    );
    assert.strictEqual(
      positionAfterUnlock.amount.toNumber(),
      0,
      "amount zeroed after unlock"
    );
    assert.strictEqual(
      positionAfterUnlock.discountEnd.toNumber(),
      lockStart + 5 * DEFAULT_LOCK_DURATION,
      "discount_end should be frozen at the last refresh's value (lock_start + 5 cycles)"
    );
    assert.deepStrictEqual(
      positionAfterUnlock.tier,
      positionAtLock.tier,
      "tier preserved after unlock — matcher still reads it"
    );

    // Earned-discount runway is still live: discount_end is exactly one full
    // cycle past the unlock moment (lockStart + 5*cycle vs lockStart + 4*cycle).
    const nowAfterUnlock = Number(svm.getClock().unixTimestamp);
    assert.ok(
      positionAfterUnlock.discountEnd.toNumber() > nowAfterUnlock,
      "discount_end should still be in the future after terminal unlock"
    );
    assert.strictEqual(
      positionAfterUnlock.discountEnd.toNumber() - nowAfterUnlock,
      DEFAULT_LOCK_DURATION,
      "earned runway past terminal unlock should equal exactly one cycle"
    );
  });

  it("early unlock fails, retry after lock_end succeeds with state unchanged by the failed attempt", async () => {
    // Proves a require!-triggered tx failure leaves every byte of vault +
    // position + user token balance exactly as it was before the tx, so a
    // later legitimate unlock sees the state the handler expects. The model
    // relies on Anchor's all-or-nothing transaction semantics; this test
    // pins the observable consequence.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
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
    const positionAfterLock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultAfterLock = await program.account.lockVault.fetch(vaultPda);
    const userTaAfterLock = await getAccount(
      provider.connection,
      userTokenAccount
    );

    // Warp to halfway through the cycle — well before lock_end.
    warpTo(
      svm,
      BigInt(
        positionAfterLock.lockStart.toNumber() +
          Math.floor(DEFAULT_LOCK_DURATION / 2)
      )
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

    // State byte-identical to post-lock — the failed tx leaked nothing.
    const positionAfterFail = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const vaultAfterFail = await program.account.lockVault.fetch(vaultPda);
    const userTaAfterFail = await getAccount(
      provider.connection,
      userTokenAccount
    );
    assert.strictEqual(
      positionAfterFail.amount.toNumber(),
      positionAfterLock.amount.toNumber(),
      "position amount unchanged by failed unlock"
    );
    assert.strictEqual(
      positionAfterFail.isActive,
      positionAfterLock.isActive,
      "position is_active unchanged"
    );
    assert.strictEqual(
      positionAfterFail.lockEnd.toNumber(),
      positionAfterLock.lockEnd.toNumber(),
      "position lock_end unchanged"
    );
    assert.strictEqual(
      positionAfterFail.discountEnd.toNumber(),
      positionAfterLock.discountEnd.toNumber(),
      "position discount_end unchanged"
    );
    assert.strictEqual(
      vaultAfterFail.totalLocked.toNumber(),
      vaultAfterLock.totalLocked.toNumber(),
      "vault.total_locked unchanged by failed unlock"
    );
    assert.strictEqual(
      vaultAfterFail.totalLockers.toNumber(),
      vaultAfterLock.totalLockers.toNumber(),
      "vault.total_lockers unchanged"
    );
    assert.strictEqual(
      userTaAfterFail.amount,
      userTaAfterLock.amount,
      "user token balance unchanged by failed unlock"
    );

    // Warp past lock_end and unlock successfully.
    warpTo(svm, BigInt(positionAfterLock.lockEnd.toNumber()));
    svm.expireBlockhash();
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    const positionAfterUnlock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const userTaAfterUnlock = await getAccount(
      provider.connection,
      userTokenAccount
    );
    assert.strictEqual(
      positionAfterUnlock.isActive,
      false,
      "position retired after the eventual successful unlock"
    );
    assert.strictEqual(
      userTaAfterUnlock.amount - userTaAfterFail.amount,
      BigInt(DEFAULT_BRONZE),
      "user received tokens back on the eventual successful unlock"
    );
    // Earned discount intact: the failed attempt did not touch discount_end.
    assert.strictEqual(
      positionAfterUnlock.discountEnd.toNumber(),
      positionAfterLock.discountEnd.toNumber(),
      "discount_end still points at lock_start + 2 * cycle_duration — unaffected by the failed unlock attempt"
    );
  });

  it("lock then refresh then unlock — refresh's new timestamps carry through to unlock cleanly", async () => {
    // Short cross-instruction flow that the single-instruction suites do
    // not exercise: the unlock happy-path test always unlocks a never-
    // refreshed position. This test proves the unlock handler's time guard
    // correctly accepts the POST-refresh lock_end and leaves the refreshed
    // discount_end intact for the matcher to read afterwards.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
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
    const lockStart = positionAtLock.lockStart.toNumber();

    // Refresh at T0 + cycle.
    warpTo(svm, BigInt(positionAtLock.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, user, vaultPda);
    const positionAfterRefresh = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const refreshedLockEnd = positionAfterRefresh.lockEnd.toNumber();
    const refreshedDiscountEnd = positionAfterRefresh.discountEnd.toNumber();

    // Warp to the POST-refresh lock_end. The unlock handler's
    // `now >= lock_end` guard must use the refreshed lock_end, not the
    // original one.
    warpTo(svm, BigInt(refreshedLockEnd));
    svm.expireBlockhash();
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    const positionAfterUnlock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionAfterUnlock.isActive,
      false,
      "position retired after the post-refresh unlock"
    );
    // lock_start never moved, lock_end holds the refreshed value, and
    // discount_end matches the refreshed advance.
    assert.strictEqual(
      positionAfterUnlock.lockStart.toNumber(),
      lockStart,
      "lock_start immutable across refresh + unlock"
    );
    assert.strictEqual(
      positionAfterUnlock.lockEnd.toNumber(),
      refreshedLockEnd,
      "lock_end preserved at the refreshed value through unlock"
    );
    assert.strictEqual(
      positionAfterUnlock.discountEnd.toNumber(),
      refreshedDiscountEnd,
      "discount_end preserved at the refreshed value through unlock"
    );
    // Earned runway still runs exactly one cycle past the unlock moment.
    const nowAfterUnlock = Number(svm.getClock().unixTimestamp);
    assert.strictEqual(
      positionAfterUnlock.discountEnd.toNumber() - nowAfterUnlock,
      DEFAULT_LOCK_DURATION,
      "post-refresh runway past unlock equals one cycle_duration"
    );
  });

  it("rejects unlock in the window between the original and refreshed lock_end", async () => {
    // Pins that the unlock handler's time guard reads the refreshed
    // lock_end from live position state, not a stale pre-refresh value.
    // Without this test, a refactor that cached lock_end somewhere else
    // (e.g., mirrored it onto the vault for indexing, or snapshotted it
    // at the top of the handler alongside the other cached-for-event
    // fields) could read the old value and silently accept unlocks in
    // the window after the original lock_end but before the refreshed
    // lock_end. State at that warp would then be corrupted without any
    // existing test catching it.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
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
    const originalLockEnd = positionAtLock.lockEnd.toNumber();

    // Refresh at the original lock_end, moving the guard to
    // originalLockEnd + cycle_duration.
    warpTo(svm, BigInt(originalLockEnd));
    svm.expireBlockhash();
    await refreshLock(program, user, vaultPda);
    const positionAfterRefresh = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    const refreshedLockEnd = positionAfterRefresh.lockEnd.toNumber();
    assert.strictEqual(
      refreshedLockEnd,
      originalLockEnd + DEFAULT_LOCK_DURATION,
      "refresh should have advanced lock_end by exactly one cycle"
    );

    // Warp ONE second past the original lock_end — inside the window
    // (originalLockEnd, refreshedLockEnd). A correct handler reads the
    // refreshed lock_end from live state and rejects. A broken handler
    // reading the pre-refresh value would see `now >= originalLockEnd`
    // and accept.
    warpTo(svm, BigInt(originalLockEnd + 1));
    svm.expireBlockhash();

    try {
      await unlockTokens(
        program,
        user,
        vaultPda,
        vaultTokenAccount,
        userTokenAccount,
        mint
      );
      assert.fail(
        "expected LockNotExpired — the unlock handler must read the refreshed lock_end"
      );
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "LockNotExpired",
        `expected LockNotExpired, got: ${err?.toString?.() ?? err}`
      );
    }

    // Position is still active and untouched — the failed tx rolled back.
    const positionAfterFailedUnlock =
      await program.account.lockPosition.fetch(lockPositionPda);
    assert.strictEqual(
      positionAfterFailedUnlock.isActive,
      true,
      "position should remain active after the rejected unlock"
    );
    assert.strictEqual(
      positionAfterFailedUnlock.amount.toNumber(),
      positionAtLock.amount.toNumber(),
      "amount should remain at the locked value"
    );
    assert.strictEqual(
      positionAfterFailedUnlock.lockEnd.toNumber(),
      refreshedLockEnd,
      "lock_end should remain at the refreshed value"
    );
    assert.strictEqual(
      positionAfterFailedUnlock.discountEnd.toNumber(),
      positionAfterRefresh.discountEnd.toNumber(),
      "discount_end should remain at the refreshed value"
    );
  });

  it("two lockers progress through refresh and unlock independently", async () => {
    // Pins cross-user isolation across the full lifecycle: every handler
    // operation on user A's position must leave user B's position and user
    // B's token balance byte-identical, and vice versa. Vault counters
    // should reflect the combined state of both users at every step.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
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

    // User A locks at Bronze, user B locks at Silver. Different amounts so
    // tier classifications differ too — cross-user contamination would
    // show up in the counters or in either user's tier/amount fields.
    const amountA = DEFAULT_BRONZE;
    const amountB = DEFAULT_SILVER * 2; // 2_000_000 → Silver
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
    const positionA0 = await program.account.lockPosition.fetch(positionAPda);
    const positionB0 = await program.account.lockPosition.fetch(positionBPda);
    const vault0 = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(
      vault0.totalLocked.toNumber(),
      amountA + amountB,
      "vault.total_locked should equal the sum of both locks"
    );
    assert.strictEqual(
      vault0.totalLockers.toNumber(),
      2,
      "vault.total_lockers should be 2 after two users lock"
    );
    assert.deepStrictEqual(
      positionA0.tier,
      { bronze: {} },
      "A classifies as Bronze at 500_000"
    );
    assert.deepStrictEqual(
      positionB0.tier,
      { silver: {} },
      "B classifies as Silver at 2_000_000"
    );

    // A refreshes at its lock_end. B's position and B's token balance
    // must be byte-identical afterward.
    warpTo(svm, BigInt(positionA0.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, userA, vaultPda);
    const positionA1 = await program.account.lockPosition.fetch(positionAPda);
    const positionB1 = await program.account.lockPosition.fetch(positionBPda);
    const taB_after_A_refresh = await getAccount(provider.connection, taB);
    assert.strictEqual(
      positionA1.lockEnd.toNumber(),
      positionA0.lockEnd.toNumber() + DEFAULT_LOCK_DURATION,
      "A's lock_end advanced by one cycle"
    );
    assert.strictEqual(
      positionB1.lockEnd.toNumber(),
      positionB0.lockEnd.toNumber(),
      "B's lock_end unaffected by A's refresh"
    );
    assert.strictEqual(
      positionB1.discountEnd.toNumber(),
      positionB0.discountEnd.toNumber(),
      "B's discount_end unaffected"
    );
    assert.strictEqual(
      positionB1.amount.toNumber(),
      positionB0.amount.toNumber(),
      "B's amount unaffected"
    );
    assert.deepStrictEqual(
      positionB1.tier,
      positionB0.tier,
      "B's tier unaffected"
    );
    assert.strictEqual(
      taB_after_A_refresh.amount,
      BigInt(USER_STARTING_BALANCE - amountB),
      "B's token balance unaffected by A's refresh"
    );

    // B refreshes at its own lock_end. A's post-refresh state must stay intact.
    warpTo(svm, BigInt(positionB0.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, userB, vaultPda);
    const positionA2 = await program.account.lockPosition.fetch(positionAPda);
    const positionB2 = await program.account.lockPosition.fetch(positionBPda);
    assert.strictEqual(
      positionB2.lockEnd.toNumber(),
      positionB0.lockEnd.toNumber() + DEFAULT_LOCK_DURATION,
      "B's lock_end advanced by one cycle"
    );
    assert.strictEqual(
      positionA2.lockEnd.toNumber(),
      positionA1.lockEnd.toNumber(),
      "A's post-refresh lock_end unchanged by B's refresh"
    );
    assert.strictEqual(
      positionA2.discountEnd.toNumber(),
      positionA1.discountEnd.toNumber(),
      "A's post-refresh discount_end unchanged by B's refresh"
    );

    // A unlocks at its refreshed lock_end. B's position stays active with
    // its full state. Vault counters drop by A's contribution only.
    warpTo(svm, BigInt(positionA1.lockEnd.toNumber()));
    svm.expireBlockhash();
    const taA_before_A_unlock = await getAccount(provider.connection, taA);
    const taB_before_A_unlock = await getAccount(provider.connection, taB);
    await unlockTokens(
      program,
      userA,
      vaultPda,
      vaultTokenAccount,
      taA,
      mint
    );
    const positionA3 = await program.account.lockPosition.fetch(positionAPda);
    const positionB3 = await program.account.lockPosition.fetch(positionBPda);
    const vault3 = await program.account.lockVault.fetch(vaultPda);
    const taA_after_A_unlock = await getAccount(provider.connection, taA);
    const taB_after_A_unlock = await getAccount(provider.connection, taB);
    assert.strictEqual(
      positionA3.isActive,
      false,
      "A retired after A's unlock"
    );
    assert.strictEqual(
      positionB3.isActive,
      true,
      "B still active after A's unlock"
    );
    assert.strictEqual(
      positionB3.amount.toNumber(),
      positionB2.amount.toNumber(),
      "B's amount unchanged"
    );
    assert.strictEqual(
      positionB3.lockEnd.toNumber(),
      positionB2.lockEnd.toNumber(),
      "B's lock_end unchanged"
    );
    assert.strictEqual(
      vault3.totalLocked.toNumber(),
      amountB,
      "total_locked drops to B's amount only"
    );
    assert.strictEqual(
      vault3.totalLockers.toNumber(),
      1,
      "total_lockers drops to 1 (B)"
    );
    assert.strictEqual(
      taA_after_A_unlock.amount - taA_before_A_unlock.amount,
      BigInt(amountA),
      "A's token balance increases by A's locked amount"
    );
    assert.strictEqual(
      taB_after_A_unlock.amount,
      taB_before_A_unlock.amount,
      "B's token balance unchanged by A's unlock"
    );

    // B unlocks at its refreshed lock_end. Final vault counters at zero.
    warpTo(svm, BigInt(positionB2.lockEnd.toNumber()));
    svm.expireBlockhash();
    await unlockTokens(
      program,
      userB,
      vaultPda,
      vaultTokenAccount,
      taB,
      mint
    );
    const vault4 = await program.account.lockVault.fetch(vaultPda);
    const positionA4 = await program.account.lockPosition.fetch(positionAPda);
    assert.strictEqual(
      vault4.totalLocked.toNumber(),
      0,
      "total_locked at zero after both unlocks"
    );
    assert.strictEqual(
      vault4.totalLockers.toNumber(),
      0,
      "total_lockers at zero after both unlocks"
    );
    // A's retired position is byte-identical to the moment after A's unlock —
    // B's unlock can't reach across to A's position.
    assert.strictEqual(
      positionA4.discountEnd.toNumber(),
      positionA3.discountEnd.toNumber(),
      "A's retained discount_end unchanged by B's later unlock"
    );
    assert.deepStrictEqual(
      positionA4.tier,
      positionA3.tier,
      "A's retained tier unchanged by B's later unlock"
    );
    assert.strictEqual(
      positionA4.isActive,
      false,
      "A remains retired"
    );
  });

  it("cannot re-lock after unlock: the LockPosition PDA persists post-unlock", async () => {
    // The earned-discount model keeps the retired LockPosition account
    // alive so the matcher can keep reading tier and discount_end until
    // discount_end elapses. A side effect: `lock` uses `init` on a PDA
    // seeded by (vault, user), so once that PDA exists, no future `lock`
    // call by the same user against the same vault can succeed — the
    // account-already-in-use failure fires before the handler runs.
    //
    // This test pins that invariant: a regression that switched `lock`'s
    // constraint to `init_if_needed` (or introduced a close_position
    // instruction without care) would silently let a user re-lock and
    // overwrite their just-earned discount_end runway. The failure here
    // is the current design's deliberate contract, not a bug.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
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
    const positionAfterLock = await program.account.lockPosition.fetch(
      lockPositionPda
    );

    // Warp past lock_end and unlock. Position is retired but the PDA lives on.
    warpTo(svm, BigInt(positionAfterLock.lockEnd.toNumber()));
    await unlockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint
    );

    const positionAfterUnlock = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionAfterUnlock.isActive,
      false,
      "position retired — is_active is false"
    );

    // Try to lock again. `init` on the PDA must fail because the account
    // already exists. We don't pin the exact error string (Anchor phrases
    // account-already-in-use slightly differently across minor versions);
    // what matters is that the call rejects and leaves the retired
    // position byte-identical to its post-unlock state. Fresh blockhash
    // immediately before the guarded tx, matching the pattern used
    // elsewhere in this file.
    svm.expireBlockhash();
    let rejectedAsExpected = false;
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
    } catch (err) {
      rejectedAsExpected = true;
    }
    assert.ok(
      rejectedAsExpected,
      "lock must reject: the LockPosition PDA for this (vault, user) already exists from the prior lock"
    );

    // Retired position survives the failed re-lock — discount_end, tier,
    // cycle_duration all unchanged from the post-unlock snapshot. Matcher
    // behavior depends on these staying intact until discount_end elapses.
    const positionAfterFailedRelock =
      await program.account.lockPosition.fetch(lockPositionPda);
    assert.strictEqual(
      positionAfterFailedRelock.isActive,
      false,
      "position still retired"
    );
    assert.strictEqual(
      positionAfterFailedRelock.amount.toNumber(),
      0,
      "position amount still zero"
    );
    assert.strictEqual(
      positionAfterFailedRelock.discountEnd.toNumber(),
      positionAfterUnlock.discountEnd.toNumber(),
      "discount_end preserved through the failed re-lock attempt"
    );
    assert.deepStrictEqual(
      positionAfterFailedRelock.tier,
      positionAfterUnlock.tier,
      "tier preserved through the failed re-lock attempt"
    );
    assert.strictEqual(
      positionAfterFailedRelock.cycleDuration.toNumber(),
      positionAfterUnlock.cycleDuration.toNumber(),
      "cycle_duration preserved"
    );
  });
});

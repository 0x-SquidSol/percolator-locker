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
import { decodeEventsForSignature } from "../test-helpers/events";
import { PercolatorLocker } from "../target/types/percolator_locker";

const LOCK_VAULT_SEED = Buffer.from("lock_vault");
const LOCK_POSITION_SEED = Buffer.from("lock_position");
const DEFAULT_LOCK_DURATION = 2_592_000; // 30 days in seconds
const MIN_LOCK_DURATION = 86_400; // 1 day
const MAX_LOCK_DURATION = 31_536_000; // 1 year
const DEFAULT_BRONZE = 500_000;
const DEFAULT_SILVER = 1_000_000;
const DEFAULT_GOLD = 5_000_000;
const DECIMALS = 6;
const USER_STARTING_BALANCE = 20_000_000;
const COOLDOWN_SECS = 7 * 24 * 60 * 60; // 7 days
// LiteSVM's initial Clock.unix_timestamp defaults to a small value, well below
// COOLDOWN_SECS. update_config's cooldown guard reads `now - last_config_update
// >= COOLDOWN_SECS`; on mainnet `now ≈ 1.8e9 >> 604_800` so the very first call
// is unrestricted, but in-process SVM needs an explicit warp for that invariant
// to hold. Set to ~year 2033 for plenty of headroom.
const INITIAL_WARP_TS = BigInt(2_000_000_000);

describe("update_config (litesvm)", () => {
  // === Setup helpers ===
  // Duplicated from litesvm-unlock.ts and litesvm-refresh-lock.ts on purpose;
  // extraction into a shared test-helpers module is tracked as a follow-up
  // refactor commit.

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
    mint: PublicKey,
    lockDuration: number = DEFAULT_LOCK_DURATION,
    bronze: number = DEFAULT_BRONZE,
    silver: number = DEFAULT_SILVER,
    gold: number = DEFAULT_GOLD
  ): Promise<{ vaultPda: PublicKey; vaultTokenAccount: PublicKey }> {
    const vaultTokenAccountKp = Keypair.generate();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [LOCK_VAULT_SEED, admin.publicKey.toBuffer()],
      program.programId
    );
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

  async function updateConfig(
    program: Program<PercolatorLocker>,
    admin: Keypair,
    vault: PublicKey,
    args: {
      lockDuration?: number | BN | null;
      bronze?: number | BN | null;
      silver?: number | BN | null;
      gold?: number | BN | null;
    } = {}
  ): Promise<void> {
    const toBnOrNull = (v: number | BN | null | undefined): BN | null => {
      if (v == null) return null;
      return v instanceof BN ? v : new BN(v);
    };
    await program.methods
      .updateConfig(
        toBnOrNull(args.lockDuration),
        toBnOrNull(args.bronze),
        toBnOrNull(args.silver),
        toBnOrNull(args.gold)
      )
      .accountsStrict({
        admin: admin.publicKey,
        vault,
      })
      .signers([admin])
      .rpc();
  }

  // Overwrite a vault's on-chain bytes to simulate a state that the program
  // cannot natively produce (e.g., tier_bronze=1 for the .max(1) cap-floor
  // test). Uses the Anchor coder for a round-trip; account discriminator,
  // lamports, and owner are preserved.
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

  it("first update after init applies all four fields and preserves all custody fields", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );
    const vaultBefore = await program.account.lockVault.fetch(vaultPda);

    const newDuration = DEFAULT_LOCK_DURATION + DEFAULT_LOCK_DURATION / 4; // +25%, within cap
    const newBronze = DEFAULT_BRONZE + DEFAULT_BRONZE / 4; // +25%
    const newSilver = DEFAULT_SILVER + DEFAULT_SILVER / 4;
    const newGold = DEFAULT_GOLD + DEFAULT_GOLD / 4;

    // Inline the update_config instruction (instead of using the updateConfig
    // helper) so the tx signature is captured for event-payload decoding
    // below. The helper discards it.
    const updateSignature = await program.methods
      .updateConfig(
        new BN(newDuration),
        new BN(newBronze),
        new BN(newSilver),
        new BN(newGold)
      )
      .accountsStrict({
        admin: admin.publicKey,
        vault: vaultPda,
      })
      .signers([admin])
      .rpc();
    const nowAfter = Number(svm.getClock().unixTimestamp);

    const vaultAfter = await program.account.lockVault.fetch(vaultPda);

    // --- Config fields updated ---
    assert.strictEqual(vaultAfter.lockDuration.toNumber(), newDuration);
    assert.strictEqual(vaultAfter.tierBronze.toNumber(), newBronze);
    assert.strictEqual(vaultAfter.tierSilver.toNumber(), newSilver);
    assert.strictEqual(vaultAfter.tierGold.toNumber(), newGold);

    // --- last_config_update stamped to the tx's clock ---
    assert.strictEqual(
      vaultAfter.lastConfigUpdate.toNumber(),
      nowAfter,
      "last_config_update should equal the clock at the time of the update"
    );

    // --- Custody + accounting fields untouched ---
    assert.ok(vaultAfter.admin.equals(vaultBefore.admin), "admin unchanged");
    assert.ok(
      vaultAfter.tokenMint.equals(vaultBefore.tokenMint),
      "token_mint unchanged"
    );
    assert.ok(
      vaultAfter.vaultTokenAccount.equals(vaultBefore.vaultTokenAccount),
      "vault_token_account unchanged"
    );
    assert.strictEqual(
      vaultAfter.totalLocked.toNumber(),
      vaultBefore.totalLocked.toNumber(),
      "total_locked untouched"
    );
    assert.strictEqual(
      vaultAfter.totalLockers.toNumber(),
      vaultBefore.totalLockers.toNumber(),
      "total_lockers untouched"
    );
    assert.strictEqual(
      vaultAfter.tokenDecimals,
      vaultBefore.tokenDecimals,
      "token_decimals untouched"
    );
    assert.strictEqual(vaultAfter.bump, vaultBefore.bump, "bump untouched");

    // --- ConfigUpdated event payload matches the state the handler wrote ---
    // Events are the public ABI consumed by downstream indexers; pinning
    // every field kills any mutation that corrupts one or drops the emit.
    // Anchor's EventParser lower-cases the first letter of the struct name
    // so Rust's `ConfigUpdated` surfaces as "configUpdated". Every field is
    // the FINAL post-update state (not the caller's args or the pre-update
    // state) — the handler emits after the writes.
    const updateEvents = decodeEventsForSignature(
      svm,
      program,
      updateSignature
    );
    assert.strictEqual(
      updateEvents.length,
      1,
      "update_config tx should emit exactly one event"
    );
    assert.strictEqual(
      updateEvents[0].name,
      "configUpdated",
      "update_config tx event name should be 'configUpdated'"
    );
    const updateData = updateEvents[0].data;
    assert.ok(
      updateData.vault.equals(vaultPda),
      "ConfigUpdated.vault should equal the vault PDA"
    );
    assert.ok(
      updateData.admin.equals(admin.publicKey),
      "ConfigUpdated.admin should equal the signer"
    );
    assert.strictEqual(
      updateData.lockDuration.toNumber(),
      newDuration,
      "ConfigUpdated.lock_duration should equal the new lock_duration"
    );
    assert.strictEqual(
      updateData.tierBronze.toNumber(),
      newBronze,
      "ConfigUpdated.tier_bronze should equal the new bronze threshold"
    );
    assert.strictEqual(
      updateData.tierSilver.toNumber(),
      newSilver,
      "ConfigUpdated.tier_silver should equal the new silver threshold"
    );
    assert.strictEqual(
      updateData.tierGold.toNumber(),
      newGold,
      "ConfigUpdated.tier_gold should equal the new gold threshold"
    );
    assert.strictEqual(
      updateData.timestamp.toNumber(),
      vaultAfter.lastConfigUpdate.toNumber(),
      "ConfigUpdated.timestamp should equal the vault's new last_config_update"
    );
  });

  it("partial update (lock_duration only) leaves tier thresholds byte-identical", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);
    const vaultBefore = await program.account.lockVault.fetch(vaultPda);

    const newDuration = DEFAULT_LOCK_DURATION + 1000;
    await updateConfig(program, admin, vaultPda, { lockDuration: newDuration });

    const vaultAfter = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(vaultAfter.lockDuration.toNumber(), newDuration);
    assert.strictEqual(
      vaultAfter.tierBronze.toNumber(),
      vaultBefore.tierBronze.toNumber(),
      "bronze unchanged on a lock_duration-only update"
    );
    assert.strictEqual(
      vaultAfter.tierSilver.toNumber(),
      vaultBefore.tierSilver.toNumber(),
      "silver unchanged"
    );
    assert.strictEqual(
      vaultAfter.tierGold.toNumber(),
      vaultBefore.tierGold.toNumber(),
      "gold unchanged"
    );
  });

  it("second update succeeds at exactly cooldown boundary (elapsed == 7 days)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // First call (cooldown unrestricted because last_config_update == 0).
    await updateConfig(program, admin, vaultPda, {
      bronze: DEFAULT_BRONZE + 1,
    });
    const vaultAfterFirst = await program.account.lockVault.fetch(vaultPda);
    const firstStamp = vaultAfterFirst.lastConfigUpdate.toNumber();

    // Warp to exactly firstStamp + COOLDOWN_SECS so elapsed == 604_800.
    warpTo(svm, BigInt(firstStamp + COOLDOWN_SECS));
    svm.expireBlockhash();

    // Second call should succeed at the boundary.
    await updateConfig(program, admin, vaultPda, {
      bronze: DEFAULT_BRONZE + 2,
    });
    const vaultAfterSecond = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(
      vaultAfterSecond.tierBronze.toNumber(),
      DEFAULT_BRONZE + 2
    );
    assert.strictEqual(
      vaultAfterSecond.lastConfigUpdate.toNumber(),
      firstStamp + COOLDOWN_SECS,
      "last_config_update should advance to the new clock at the boundary"
    );
  });

  it("cap allows a +50% increase exactly at the boundary", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // delta = 250_000 == 500_000 / 2, should pass.
    const target = DEFAULT_BRONZE + DEFAULT_BRONZE / 2;
    await updateConfig(program, admin, vaultPda, { bronze: target });
    const vault = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(vault.tierBronze.toNumber(), target);
  });

  it("cap allows a -50% decrease exactly at the boundary", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // delta = 250_000 == 500_000 / 2, decrease passes too (abs_diff is symmetric).
    const target = DEFAULT_BRONZE - DEFAULT_BRONZE / 2;
    await updateConfig(program, admin, vaultPda, { bronze: target });
    const vault = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(vault.tierBronze.toNumber(), target);
  });

  it("MIN_TIER_BRONZE floor rejects escape from a below-minimum pathological state", async () => {
    // A vault pathologically stuck at bronze=1 (only reachable via setVaultState
    // injection; init and update_config's final-state check both reject any
    // bronze below MIN_TIER_BRONZE) can still pass the (old/2).max(1) per-call
    // cap for a +1 move, but the final-state floor rejects the resulting
    // bronze=2 because 2 < MIN_TIER_BRONZE. The cap + floor together prevent
    // small-threshold states from escaping through repeated update_config calls.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    await setVaultState(svm, program, vaultPda, (vault) => {
      vault.tierBronze = new BN(1);
      vault.tierSilver = new BN(2);
      vault.tierGold = new BN(3);
    });
    svm.expireBlockhash();

    try {
      await updateConfig(program, admin, vaultPda, {
        bronze: 2,
        silver: 3,
        gold: 4,
      });
      assert.fail("expected TierBronzeBelowMinimum");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "TierBronzeBelowMinimum",
        `expected TierBronzeBelowMinimum, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("new lock after an update_config uses the new cycle_duration snapshot", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );

    // Bump lock_duration by up to the full MIN..MAX window; pick a modest step
    // to keep numbers readable.
    const newDuration = DEFAULT_LOCK_DURATION + 3600;
    await updateConfig(program, admin, vaultPda, { lockDuration: newDuration });
    svm.expireBlockhash();

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
    assert.strictEqual(
      position.cycleDuration.toNumber(),
      newDuration,
      "new lock should snapshot the POST-update lock_duration"
    );
  });

  it("new lock after an update_config classifies against the new tier thresholds", async () => {
    // Tier-direction analog of the cycle_duration snapshot test above:
    // proves that lock.rs's calculate_tier call reads the vault's LIVE
    // tier_bronze/silver/gold at lock time, so an admin retune via
    // update_config is observable on the very next lock. Without this
    // coverage a regression that cached thresholds at init (or read a
    // stale copy) would pass the cycle_duration test yet silently
    // misclassify new positions.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda, vaultTokenAccount } = await initVault(
      program,
      admin,
      mint
    );

    // Raise silver by the full 50% cap (1_000_000 -> 1_500_000). Bronze and
    // gold stay put, so bronze < silver < gold still holds (500K < 1.5M < 5M).
    const newSilver = DEFAULT_SILVER + DEFAULT_SILVER / 2;
    await updateConfig(program, admin, vaultPda, { silver: newSilver });
    svm.expireBlockhash();

    const { user, userTokenAccount } = await setupUser(
      svm,
      provider,
      mint,
      admin,
      USER_STARTING_BALANCE
    );
    // X = DEFAULT_SILVER = 1_000_000: under OLD thresholds this is exactly
    // Silver; under NEW thresholds it is Bronze (X >= bronze 500K but X <
    // new silver 1.5M). The tier classification is observably different
    // between the two worlds, so the assertion pins the live-read semantic.
    const amount = DEFAULT_SILVER;
    const lockPositionPda = await lockTokens(
      program,
      user,
      vaultPda,
      vaultTokenAccount,
      userTokenAccount,
      mint,
      amount
    );
    const position = await program.account.lockPosition.fetch(lockPositionPda);
    assert.deepStrictEqual(
      position.tier,
      { bronze: {} },
      "new lock should classify against the POST-update tier thresholds (Bronze), not the pre-update thresholds (which would have been Silver)"
    );
  });

  it("existing lock position is fully immune to update_config: position fields, refresh behavior, and vault accounting all preserved", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
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

    // Lock at original thresholds — position snapshots the pre-update values.
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

    // Admin retunes every config field (all within the per-call 50% cap).
    const newDuration = DEFAULT_LOCK_DURATION + 1000;
    const newBronze = DEFAULT_BRONZE + DEFAULT_BRONZE / 4;
    const newSilver = DEFAULT_SILVER + DEFAULT_SILVER / 4;
    const newGold = DEFAULT_GOLD + DEFAULT_GOLD / 4;
    await updateConfig(program, admin, vaultPda, {
      lockDuration: newDuration,
      bronze: newBronze,
      silver: newSilver,
      gold: newGold,
    });
    svm.expireBlockhash();

    // --- Position fields all preserved ---
    const positionAfter = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.deepStrictEqual(
      positionAfter.tier,
      positionBefore.tier,
      "tier preserved — not re-evaluated against new thresholds"
    );
    assert.strictEqual(
      positionAfter.cycleDuration.toNumber(),
      positionBefore.cycleDuration.toNumber(),
      "cycle_duration preserved — snapshot taken at lock time"
    );
    assert.strictEqual(
      positionAfter.lockEnd.toNumber(),
      positionBefore.lockEnd.toNumber(),
      "lock_end preserved"
    );
    assert.strictEqual(
      positionAfter.discountEnd.toNumber(),
      positionBefore.discountEnd.toNumber(),
      "discount_end preserved"
    );
    assert.strictEqual(
      positionAfter.amount.toNumber(),
      positionBefore.amount.toNumber(),
      "amount preserved"
    );
    assert.strictEqual(
      positionAfter.isActive,
      positionBefore.isActive,
      "is_active preserved"
    );

    // --- refresh_lock on this position uses the ORIGINAL snapshot ---
    // Warp to exactly position.lockEnd (pre-update value) and refresh. The
    // advance MUST use position.cycle_duration (= DEFAULT_LOCK_DURATION), NOT
    // the vault's new lock_duration.
    warpTo(svm, BigInt(positionBefore.lockEnd.toNumber()));
    svm.expireBlockhash();
    await refreshLock(program, user, vaultPda);
    const positionAfterRefresh = await program.account.lockPosition.fetch(
      lockPositionPda
    );
    assert.strictEqual(
      positionAfterRefresh.lockEnd.toNumber(),
      positionBefore.lockEnd.toNumber() + DEFAULT_LOCK_DURATION,
      "refresh should advance by the snapshot cycle_duration, not the new vault value"
    );
    assert.strictEqual(
      positionAfterRefresh.cycleDuration.toNumber(),
      DEFAULT_LOCK_DURATION,
      "cycle_duration still pinned to original snapshot after refresh"
    );

    // --- Vault accounting / custody fields unchanged ---
    const vaultAfter = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(
      vaultAfter.totalLocked.toNumber(),
      vaultBefore.totalLocked.toNumber(),
      "total_locked untouched by update_config"
    );
    assert.strictEqual(
      vaultAfter.totalLockers.toNumber(),
      vaultBefore.totalLockers.toNumber(),
      "total_lockers untouched by update_config"
    );
    assert.ok(
      vaultAfter.admin.equals(vaultBefore.admin),
      "admin untouched by update_config"
    );
    assert.ok(
      vaultAfter.tokenMint.equals(vaultBefore.tokenMint),
      "token_mint untouched"
    );
    assert.ok(
      vaultAfter.vaultTokenAccount.equals(vaultBefore.vaultTokenAccount),
      "vault_token_account untouched"
    );
    assert.strictEqual(vaultAfter.tokenDecimals, vaultBefore.tokenDecimals);
    assert.strictEqual(vaultAfter.bump, vaultBefore.bump);
  });

  it("rejects calls from any signer other than the recorded admin", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    const attacker = setupAdmin(svm); // any other funded signer
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    try {
      await program.methods
        .updateConfig(null, new BN(DEFAULT_BRONZE + 1), null, null)
        .accountsStrict({ admin: attacker.publicKey, vault: vaultPda })
        .signers([attacker])
        .rpc();
      assert.fail("expected ConstraintHasOne");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConstraintHasOne",
        `expected ConstraintHasOne, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a call with all four args None (EmptyConfigUpdate)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    try {
      await updateConfig(program, admin, vaultPda, {});
      assert.fail("expected EmptyConfigUpdate");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "EmptyConfigUpdate",
        `expected EmptyConfigUpdate, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a second call inside the cooldown window (ConfigCooldownActive)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    await updateConfig(program, admin, vaultPda, { bronze: DEFAULT_BRONZE + 1 });
    const vaultAfterFirst = await program.account.lockVault.fetch(vaultPda);

    // Warp to exactly last_config_update + COOLDOWN - 1 — elapsed = 604_799,
    // just below the threshold.
    warpTo(
      svm,
      BigInt(vaultAfterFirst.lastConfigUpdate.toNumber() + COOLDOWN_SECS - 1)
    );
    svm.expireBlockhash();

    try {
      await updateConfig(program, admin, vaultPda, {
        bronze: DEFAULT_BRONZE + 2,
      });
      assert.fail("expected ConfigCooldownActive");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConfigCooldownActive",
        `expected ConfigCooldownActive, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a threshold change that exceeds the per-call cap by one unit (ConfigChangeOverLimit)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // cap = 500_000 / 2 = 250_000; delta of 250_001 is one unit over.
    const target = DEFAULT_BRONZE + DEFAULT_BRONZE / 2 + 1;
    try {
      await updateConfig(program, admin, vaultPda, { bronze: target });
      assert.fail("expected ConfigChangeOverLimit");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConfigChangeOverLimit",
        `expected ConfigChangeOverLimit, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a threshold decrease that exceeds the per-call cap by one unit (ConfigChangeOverLimit)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // cap = 500_000 / 2 = 250_000; a decrease of 250_001 is one unit over.
    // abs_diff is symmetric, so the handler must reject the decrease direction
    // identically to the increase direction covered by the preceding test.
    // Without this coverage a future swap from abs_diff to saturating_sub
    // (which returns 0 whenever new < old) would silently bypass the cap for
    // every downward change.
    const target = DEFAULT_BRONZE - (DEFAULT_BRONZE / 2 + 1);
    try {
      await updateConfig(program, admin, vaultPda, { bronze: target });
      assert.fail("expected ConfigChangeOverLimit");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConfigChangeOverLimit",
        `expected ConfigChangeOverLimit, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a final state where silver <= bronze (InvalidTierThresholds)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // Move bronze up to silver in one call: 500_000 -> 750_000 (within cap),
    // but silver stays at 1_000_000, so silver > bronze still holds. Instead
    // push bronze to 750_000 and silver DOWN by 25% to 750_000 — both within
    // cap, final bronze == silver fails silver > bronze check.
    try {
      await updateConfig(program, admin, vaultPda, {
        bronze: 750_000,
        silver: 750_000,
      });
      assert.fail("expected InvalidTierThresholds (silver <= bronze)");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "InvalidTierThresholds",
        `expected InvalidTierThresholds, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a final state where gold <= silver (InvalidTierThresholds)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // Push silver up to gold: silver 1_000_000 -> 1_500_000 (within 50%),
    // gold drops to 1_500_000 (from 5_000_000, delta 3.5M > cap 2.5M) — would
    // fail on cap first. Instead drop gold exactly within cap and raise
    // silver so they tie: silver 1_000_000 -> 1_500_000 (+50%, at cap),
    // gold 5_000_000 -> 2_500_000 (-50%, at cap). Final: silver=1_500_000,
    // gold=2_500_000 still satisfies gold>silver. Need gold==silver:
    // silver 1M -> 1.5M (at cap), gold 5M -> 1.5M is -70%, over cap.
    // Do it in two calls? One call, keep bronze/silver and drop gold by the
    // max allowed and silver up the max allowed:
    //   silver: +50% -> 1_500_000
    //   gold: -50% -> 2_500_000 (still > silver, passes)
    // So a single-call gold<=silver violation requires hitting it via
    // contrived edges. Simplest: raise silver to gold exactly.
    //   silver: 1_000_000 -> 1_500_000 (+50% cap)
    //   gold:   5_000_000 -> 1_500_000 would need -70% — over cap.
    // Alternative: raise bronze and silver both well within cap so silver
    // clears gold. Not reachable without pre-setting gold low via setVaultState.
    // Simulate vault state where gold is within one cap-step of silver.
    await setVaultState(svm, program, vaultPda, (vault) => {
      vault.tierSilver = new BN(1_000_000);
      vault.tierGold = new BN(1_100_000);
    });
    svm.expireBlockhash();

    // Now raise silver by within cap (+50% = 1_500_000). Final silver=1.5M,
    // gold=1.1M → gold <= silver fires.
    try {
      await updateConfig(program, admin, vaultPda, { silver: 1_500_000 });
      assert.fail("expected InvalidTierThresholds (gold <= silver)");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "InvalidTierThresholds",
        `expected InvalidTierThresholds, got: ${err?.toString?.() ?? err}`
      );
    }
  });

  it("rejects a final state where bronze == 0 (TierBronzeBelowMinimum)", async () => {
    // Reaching bronze=0 requires bronze currently at 1 (cap = max(0,1) = 1
    // allows delta of 1 down to 0). Simulate that pathological pre-state via
    // setVaultState, then attempt update to 0 — the MIN_TIER_BRONZE final-state
    // floor rejects before the ordering checks can fire.
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    await setVaultState(svm, program, vaultPda, (vault) => {
      vault.tierBronze = new BN(1);
      vault.tierSilver = new BN(2);
      vault.tierGold = new BN(3);
    });
    svm.expireBlockhash();

    try {
      await updateConfig(program, admin, vaultPda, { bronze: 0 });
      assert.fail("expected TierBronzeBelowMinimum (bronze == 0)");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "TierBronzeBelowMinimum",
        `expected TierBronzeBelowMinimum (bronze == 0), got: ${
          err?.toString?.() ?? err
        }`
      );
    }
  });

  it("rejects a lock_duration below MIN_LOCK_DURATION (LockDurationTooShort)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // Pre-seed lock_duration to a value where MIN - 1 is reachable within the
    // per-call cap, so the MIN bound guard fires cleanly instead of being
    // masked by the lock_duration cap. old = 172_797, cap = old/2 = 86_398,
    // delta to MIN - 1 = 86_399 is 86_398 (exactly at cap), passes.
    await setVaultState(svm, program, vaultPda, (vault) => {
      vault.lockDuration = new BN(172_797);
    });
    svm.expireBlockhash();

    try {
      await updateConfig(program, admin, vaultPda, {
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

  it("rejects a lock_duration above MAX_LOCK_DURATION (LockDurationTooLong)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    // Warp past COOLDOWN_SECS so the first update_config call is unrestricted,
    // as the handler's doc-comment promises (relies on mainnet-realistic `now`).
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // Pre-seed lock_duration to a value where MAX + 1 is reachable within the
    // per-call cap. old = 21_024_001, cap = old/2 = 10_512_000, delta to
    // MAX + 1 = 31_536_001 is 10_512_000 (exactly at cap), passes — so MAX
    // bound guard fires rather than the per-call magnitude cap.
    await setVaultState(svm, program, vaultPda, (vault) => {
      vault.lockDuration = new BN(21_024_001);
    });
    svm.expireBlockhash();

    try {
      await updateConfig(program, admin, vaultPda, {
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

  it("cap allows a +50% lock_duration increase exactly at the boundary", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // delta = DEFAULT_LOCK_DURATION / 2 == cap; final 3_888_000 < MAX.
    const target = DEFAULT_LOCK_DURATION + DEFAULT_LOCK_DURATION / 2;
    await updateConfig(program, admin, vaultPda, { lockDuration: target });
    const vault = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(vault.lockDuration.toNumber(), target);
  });

  it("cap allows a -50% lock_duration decrease exactly at the boundary", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // delta = DEFAULT_LOCK_DURATION / 2 == cap; final 1_296_000 > MIN.
    // abs_diff is symmetric so the decrease direction must pass identically
    // to the increase direction above.
    const target = DEFAULT_LOCK_DURATION - DEFAULT_LOCK_DURATION / 2;
    await updateConfig(program, admin, vaultPda, { lockDuration: target });
    const vault = await program.account.lockVault.fetch(vaultPda);
    assert.strictEqual(vault.lockDuration.toNumber(), target);
  });

  it("rejects a lock_duration change that exceeds the per-call cap by one unit (ConfigChangeOverLimit)", async () => {
    const { svm, provider, program } = makeHarness();
    const admin = setupAdmin(svm);
    warpTo(svm, INITIAL_WARP_TS);
    const mint = await createTestMint(svm, provider, admin);
    const { vaultPda } = await initVault(program, admin, mint);

    // cap = DEFAULT_LOCK_DURATION / 2 = 1_296_000; delta of 1_296_001 is one
    // unit over. Pins the cap boundary for lock_duration identically to the
    // tier-side cap tests.
    const target = DEFAULT_LOCK_DURATION + DEFAULT_LOCK_DURATION / 2 + 1;
    try {
      await updateConfig(program, admin, vaultPda, { lockDuration: target });
      assert.fail("expected ConfigChangeOverLimit");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ConfigChangeOverLimit",
        `expected ConfigChangeOverLimit, got: ${err?.toString?.() ?? err}`
      );
    }
  });
});

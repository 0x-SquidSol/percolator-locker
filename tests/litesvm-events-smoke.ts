import { BN } from "@coral-xyz/anchor";
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
import { assert } from "chai";
import { makeHarness } from "../test-helpers/litesvm";
import { decodeEventsForSignature } from "../test-helpers/events";

const LOCK_VAULT_SEED = Buffer.from("lock_vault");
const LOCK_POSITION_SEED = Buffer.from("lock_position");
const DEFAULT_LOCK_DURATION = 2_592_000;
const DEFAULT_BRONZE = 500_000;
const DEFAULT_SILVER = 1_000_000;
const DEFAULT_GOLD = 5_000_000;
const DECIMALS = 6;

/**
 * Smoke test for the `decodeEventsForSignature` helper.
 *
 * Goal: prove that after a real on-chain instruction, the helper can
 * fetch the transaction's metadata from the in-process SVM, parse the
 * Anchor program logs, and return a typed event object whose fields
 * match what the handler claims to emit. If this passes, every
 * LiteSVM test that wants to assert on event payloads can use the
 * helper the same way.
 *
 * Kept minimal on purpose — only covers the happy path on a single
 * Locked event from one lock call. Broader coverage lives in the
 * per-instruction test files.
 */
describe("event decoder smoke test", () => {
  it("decodes a Locked event emitted by a real lock call", async () => {
    const { svm, provider, program } = makeHarness();

    // Minimal vault + user setup. Inlined to keep the smoke-test file
    // self-contained; heavier helpers live in the per-instruction suites.
    const admin = Keypair.generate();
    svm.airdrop(admin.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

    const mintKp = Keypair.generate();
    const mintRent = svm.getRent().minimumBalance(BigInt(MINT_SIZE));
    await provider.sendAndConfirm!(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mintKp.publicKey,
          lamports: Number(mintRent),
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mintKp.publicKey,
          DECIMALS,
          admin.publicKey,
          null
        )
      ),
      [admin, mintKp]
    );
    const mint = mintKp.publicKey;

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

    const user = Keypair.generate();
    svm.airdrop(user.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    const userTokenAccountKp = Keypair.generate();
    const accountRent = svm.getRent().minimumBalance(BigInt(ACCOUNT_SIZE));
    await provider.sendAndConfirm!(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: userTokenAccountKp.publicKey,
          lamports: Number(accountRent),
          space: ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(
          userTokenAccountKp.publicKey,
          mint,
          user.publicKey
        ),
        createMintToInstruction(
          mint,
          userTokenAccountKp.publicKey,
          admin.publicKey,
          DEFAULT_BRONZE * 10
        )
      ),
      [admin, userTokenAccountKp]
    );
    const userTokenAccount = userTokenAccountKp.publicKey;

    const [lockPositionPda] = PublicKey.findProgramAddressSync(
      [LOCK_POSITION_SEED, vaultPda.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );

    // Execute the lock and capture its tx signature. The helper will pull
    // the matching TransactionMetadata from the SVM and decode any program
    // logs into typed event objects.
    const signature = await program.methods
      .lock(new BN(DEFAULT_BRONZE))
      .accountsStrict({
        user: user.publicKey,
        vault: vaultPda,
        lockPosition: lockPositionPda,
        userTokenAccount,
        vaultTokenAccount: vaultTokenAccountKp.publicKey,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const events = decodeEventsForSignature(svm, program, signature);

    // Exactly one event, named Locked, with the amount and user/vault we
    // just sent. Field-by-field assertions live in the per-instruction
    // test files; here we only prove the decoding round-trip works.
    assert.strictEqual(events.length, 1, "exactly one event should be emitted");
    // Anchor's EventParser lower-cases the first letter of the event name
    // to match the TypeScript camelCase convention, so an event declared
    // `pub struct Locked {...}` in Rust surfaces here as "locked".
    assert.strictEqual(events[0].name, "locked", "event name should be locked");
    assert.ok(
      events[0].data.user.equals(user.publicKey),
      "Locked.user should match the signer"
    );
    assert.ok(
      events[0].data.vault.equals(vaultPda),
      "Locked.vault should match the vault PDA"
    );
    assert.strictEqual(
      events[0].data.amount.toNumber(),
      DEFAULT_BRONZE,
      "Locked.amount should match the locked amount"
    );
  });
});

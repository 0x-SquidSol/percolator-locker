import { LiteSVM, Clock } from "litesvm";
import { LiteSVMProvider } from "anchor-litesvm";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { PercolatorLocker } from "../target/types/percolator_locker";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../target/idl/percolator_locker.json");

/**
 * Smoke test for the LiteSVM harness.
 *
 * Goal: prove the three harness primitives work before any real test logic
 * depends on them — (1) loading the program's .so into an in-process SVM,
 * (2) constructing an Anchor `Program` against a LiteSVMProvider, and
 * (3) advancing the Clock sysvar via `setClock` (the primitive that makes
 * time-based tests possible in the first place).
 *
 * No instruction calls, no mints, no state writes. If this fails, we know
 * the harness is the problem; if it passes, any subsequent failure in a
 * real test is test logic, not infrastructure.
 */
describe("litesvm harness smoke test", () => {
  const PROGRAM_ID = new PublicKey(
    "91JU1rmiLAPNcmC9Kew8cCXTRGFW1Pe67ZreijUia5S8"
  );
  const PROGRAM_SO_PATH = "target/deploy/percolator_locker.so";

  it("loads the program, wires an Anchor Program, and warps the clock", () => {
    // Spin up an in-process SVM and load our program's .so
    const svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_ID, PROGRAM_SO_PATH);

    // Verify the program account is present and executable
    const programAccount = svm.getAccount(PROGRAM_ID);
    assert.ok(programAccount !== null, "program account should be loaded");
    assert.ok(
      programAccount!.executable,
      "program account should be executable"
    );

    // Build an Anchor Program against the LiteSVM-backed provider.
    // If this compiles-and-constructs cleanly, Anchor can dispatch calls
    // against LiteSVM the same way it does against a test-validator.
    const provider = new LiteSVMProvider(svm);
    const program = new Program<PercolatorLocker>(
      idl as any,
      provider as any
    );
    assert.ok(
      program.programId.equals(PROGRAM_ID),
      "Anchor Program should carry the correct program id"
    );

    // Warp the on-chain clock forward and verify it took effect.
    // This is the primitive that unblocks every time-based test in the
    // upcoming Phase 5/6/8 work — unlock's `now >= lock_end`, refresh_lock's
    // cycle check, and any discount_end expiry scenario all depend on it.
    const before = svm.getClock();
    const targetTs = before.unixTimestamp + BigInt(31 * 24 * 60 * 60); // +31 days
    svm.setClock(
      new Clock(
        before.slot,
        before.epochStartTimestamp,
        before.epoch,
        before.leaderScheduleEpoch,
        targetTs
      )
    );
    const after = svm.getClock();
    assert.strictEqual(
      after.unixTimestamp,
      targetTs,
      "setClock should advance the on-chain unix_timestamp"
    );
  });
});

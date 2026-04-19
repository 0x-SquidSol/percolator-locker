import { Clock } from "litesvm";
import { assert } from "chai";
import { makeHarness } from "../test-helpers/litesvm";

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
  it("loads the program, wires an Anchor Program, and warps the clock", () => {
    const { svm, program, programId } = makeHarness();

    // Program account present + executable. `svm.getAccount` returns the
    // web3.js `AccountInfo<Uint8Array>` shape (not the raw napi Account
    // class), so `executable` is a boolean property, not a method.
    const programAccount = svm.getAccount(programId);
    assert.ok(programAccount !== null, "program account should be loaded");
    assert.strictEqual(
      programAccount!.executable,
      true,
      "program account should be executable"
    );

    // Anchor Program carries the right program id — proves the IDL address
    // was read correctly and the provider wiring is consistent.
    assert.ok(
      program.programId.equals(programId),
      "Anchor Program should carry the correct program id"
    );

    // Warp the on-chain clock forward and verify the sysvar moved. This is
    // the primitive that unblocks every future time-based test — unlock's
    // `now >= lock_end`, refresh_lock's cycle check, any discount_end
    // expiry scenario.
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

import { LiteSVM, Clock } from "litesvm";
import { LiteSVMProvider } from "anchor-litesvm";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PercolatorLocker } from "../target/types/percolator_locker";
import idl from "../target/idl/percolator_locker.json";

/**
 * Bootstrap an in-process LiteSVM environment with the percolator-locker
 * program loaded and an Anchor `Program` bound to it.
 *
 * Used by every time-based test (unlock, refresh_lock, integration lifecycle,
 * any scenario that needs `discount_end` expiry) because `solana-test-validator`
 * cannot advance the Clock sysvar's `unix_timestamp` — its `warpToSlot` RPC
 * moves the slot but leaves wall-clock time alone, and there's no supported
 * `setClock` RPC on stock test-validator.
 *
 * The program binary path is CWD-relative — `anchor test` (and our WSL
 * helper scripts) always invoke mocha from the repo root, so this resolves
 * to `<repo>/target/deploy/percolator_locker.so`.
 */
export interface LiteSVMHarness {
  svm: LiteSVM;
  provider: LiteSVMProvider;
  program: Program<PercolatorLocker>;
  programId: PublicKey;
}

const PROGRAM_SO_PATH = "target/deploy/percolator_locker.so";

export function makeHarness(): LiteSVMHarness {
  const programId = new PublicKey((idl as { address: string }).address);
  const svm = new LiteSVM();
  svm.addProgramFromFile(programId, PROGRAM_SO_PATH);

  // The `as never` casts paper over a type-surface mismatch: anchor-litesvm@0.2.1
  // was built against an earlier Anchor Provider interface shape than 0.31.1's.
  // Runtime behavior is correct. TODO: remove when anchor-litesvm publishes
  // an Anchor-0.31-compatible Provider typing.
  const provider = new LiteSVMProvider(svm);
  const program = new Program<PercolatorLocker>(
    idl as never,
    provider as never
  );

  return { svm, provider, program, programId };
}

/**
 * Advance LiteSVM's Clock sysvar to the given unix timestamp, leaving slot,
 * epoch, epochStartTimestamp, and leaderScheduleEpoch unchanged. This is
 * the primitive that makes time-based handler guards testable —
 * `require!(now >= lock_end)` in unlock, `require!(now >= lock_end)` in
 * refresh_lock, `discount_end > now` in any matcher-adjacent assertion.
 */
export function warpTo(svm: LiteSVM, targetUnixTs: bigint): void {
  const before = svm.getClock();
  svm.setClock(
    new Clock(
      before.slot,
      before.epochStartTimestamp,
      before.epoch,
      before.leaderScheduleEpoch,
      targetUnixTs
    )
  );
}

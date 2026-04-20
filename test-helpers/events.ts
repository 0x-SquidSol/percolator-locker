import { EventParser, Idl, Program } from "@coral-xyz/anchor";
import {
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import bs58 from "bs58";

/**
 * One decoded Anchor event.
 *
 * `name` is the event struct name from the IDL (e.g. "Locked").
 * `data` is the event's fields — field values follow Anchor's TypeScript
 * decoding conventions (BN for u64/i64, base58 PublicKeys, Tier enum as
 * `{ bronze: {} }` shape, etc.).
 */
export interface DecodedEvent {
  name: string;
  data: any;
}

/**
 * Decode every Anchor event emitted by the transaction whose signature
 * was returned by `.rpc()`. Reads the transaction's metadata from the
 * in-process SVM (events are not otherwise observable in LiteSVM — no
 * websocket, so `program.addEventListener` does not work) and walks
 * each program log line for our program, decoding the base64-encoded
 * event payloads via the provided `Program`'s Anchor coder.
 *
 * Used by tests that need to verify the exact contents of emitted
 * events — Locked, Unlocked, Refreshed, ConfigUpdated — so that a bug
 * corrupting any event field would fail loudly on-chain rather than
 * silently corrupt downstream indexers.
 *
 * Throws if the signature is not found, or if the transaction failed.
 * The caller holds the invariant "the action that produced `signature`
 * succeeded"; a failed tx would not emit events anyway.
 */
export function decodeEventsForSignature<T extends Idl>(
  svm: LiteSVM,
  program: Program<T>,
  signature: string
): DecodedEvent[] {
  const sigBytes = bs58.decode(signature);
  const meta = svm.getTransaction(sigBytes);
  if (meta === null) {
    throw new Error(
      `decodeEventsForSignature: transaction ${signature} not found on the SVM`
    );
  }
  if (meta instanceof FailedTransactionMetadata) {
    throw new Error(
      `decodeEventsForSignature: transaction ${signature} failed; events are only parsed from successful transactions`
    );
  }
  return decodeEventsFromLogs(program, (meta as TransactionMetadata).logs());
}

/**
 * Lower-level helper: decode every Anchor event from a pre-fetched
 * array of log strings. Useful when callers already have the log
 * array in hand (e.g. from `simulate()` or a pre-existing meta lookup).
 */
export function decodeEventsFromLogs<T extends Idl>(
  program: Program<T>,
  logs: string[]
): DecodedEvent[] {
  const parser = new EventParser(program.programId, program.coder);
  const out: DecodedEvent[] = [];
  for (const event of parser.parseLogs(logs)) {
    out.push({ name: event.name, data: event.data });
  }
  return out;
}

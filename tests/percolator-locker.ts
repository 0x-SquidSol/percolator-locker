import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PercolatorLocker } from "../target/types/percolator_locker";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

describe("percolator-locker", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PercolatorLocker as Program<PercolatorLocker>;
  const connection = provider.connection;

  // --- Helper functions ---

  /** Airdrop SOL to a wallet for transaction fees and rent */
  async function airdrop(to: PublicKey, amount = 10 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(to, amount);
    await connection.confirmTransaction(sig, "confirmed");
  }

  /** Create a new SPL token mint */
  async function createTestMint(
    authority: Keypair,
    decimals = 6
  ): Promise<PublicKey> {
    return await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );
  }

  /** Create a token account for a given mint and owner */
  async function createTestTokenAccount(
    payer: Keypair,
    mint: PublicKey,
    owner: PublicKey
  ): Promise<PublicKey> {
    return await createAccount(connection, payer, mint, owner);
  }

  /** Mint tokens to a token account */
  async function mintTestTokens(
    authority: Keypair,
    mint: PublicKey,
    destination: PublicKey,
    amount: number
  ): Promise<void> {
    await mintTo(connection, authority, mint, destination, authority, amount);
  }

  /** Derive the vault PDA from an admin public key */
  function deriveVaultPda(admin: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lock_vault"), admin.toBuffer()],
      program.programId
    );
  }

  /** Derive the lock position PDA from a vault and user */
  function deriveLockPositionPda(
    vault: PublicKey,
    user: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lock_position"), vault.toBuffer(), user.toBuffer()],
      program.programId
    );
  }
});

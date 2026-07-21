// Stub for the per-account NWC wallet client hook. The original module
// wasn't committed; this keeps `/app` compiling. Replace with the real
// NWC client (decrypts URI via local-store, opens NIP-47 connection,
// exposes payInvoice/makeInvoice/getBalance).

import type { NipSigner } from '@/lib/nip-59';

export interface LocalWalletClient {
  payInvoice: (args: { invoice: string }) => Promise<{ preimage?: string }>;
  makeInvoice: (args: { amount: number; description: string }) => Promise<{ invoice?: string }>;
  getBalance: () => Promise<{ balance?: number }>;
}

export function useLocalWallet(
  _pubkey: string | null,
  _signer: Pick<NipSigner, 'pubkey' | 'nip44Encrypt' | 'nip44Decrypt'> | null,
): { client: LocalWalletClient | null } {
  return { client: null };
}

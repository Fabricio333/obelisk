'use client';

import { useMemo, useState } from 'react';
import { parseBolt11, type ParsedInvoice } from '@/lib/bolt11';
import { useMyPubkey, useNipSigner, useUserMetadata } from '@/lib/nostr-bridge';
import { formatPubkey } from '@nostr-wot/data';
import { useLocalWallet } from '@/lib/wallet/local-client';

interface Props {
  invoice: string;
  messageId?: string;
  channelId?: string;
}

interface PaidState {
  payerPubkey: string;
  paidAt: string;
}

/**
 * Renders a public BOLT11 invoice posted in chat as a payable card.
 * Any channel member with an NWC wallet can click Pay; the local NWC
 * payment flow runs entirely client-side.
 *
 * TODO(decentralized-invoice-tracking): the previous /api/invoices/* server
 * orchestrated race protection and broadcast paid-state across clients via
 * Socket.io. With the relays-only architecture we no longer have a server
 * to coordinate. The replacement is to publish a kind:9735-style
 * "invoice paid" Nostr event in the channel; other clients listen and
 * flip their own local paid state. Until that lands, paid state is
 * device-local only — refreshing or opening the channel from a different
 * device will not show "Paid" for invoices another user paid.
 */
export default function InvoiceCard({ invoice, messageId: _messageId, channelId: _channelId }: Props) {
  const myPubkey = useMyPubkey();
  const signer = useNipSigner();
  const { client: _walletClient } = useLocalWallet(myPubkey, signer);

  const parsed = useMemo<ParsedInvoice | null>(() => {
    try { return parseBolt11(invoice); } catch { return null; }
  }, [invoice]);

  const [paid, setPaid] = useState<PaidState | null>(null);
  const [busy, setBusy] = useState(false);
  const payerMeta = useUserMetadata(paid?.payerPubkey ?? null);

  if (!parsed) {
    return (
      <span className="block mt-1 px-3 py-2 rounded-lg border border-lc-border text-xs text-lc-muted">
        ⚠️ Invoice inválida
      </span>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = !paid && parsed.expiresAt && parsed.expiresAt < now;

  const pay = async () => {
    if (busy || paid || expired) return;
    if (!_walletClient) return;
    setBusy(true);
    try {
      await _walletClient.payInvoice({ invoice });
      setPaid({ payerPubkey: myPubkey || '?', paidAt: new Date().toISOString() });
    } catch {
      // The wallet surface has no inline error UI yet.
    } finally {
      setBusy(false);
    }
  };

  const payerName = paid
    ? payerMeta?.displayName ?? payerMeta?.name ?? (paid.payerPubkey.length === 64 ? formatPubkey(paid.payerPubkey) : null)
    : null;

  return (
    <span
      className="block mt-1 max-w-sm rounded-xl border border-lc-border bg-lc-black/40 p-3"
      data-testid="invoice-card"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-lc-green text-lg" aria-hidden>⚡</span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-lc-white">
              {parsed.amountSats.toLocaleString()} sats
            </span>
            {parsed.description && (
              <span className="block text-[11px] text-lc-muted truncate">{parsed.description}</span>
            )}
          </span>
        </span>
        {paid ? (
          <span className="shrink-0 text-[11px] text-lc-green font-semibold" data-testid="invoice-paid">
            ✅ Pagada{payerName ? ` · ${payerName}` : ''}
          </span>
        ) : expired ? (
          <span className="shrink-0 text-[11px] text-lc-muted">Expirada</span>
        ) : (
          <button
            onClick={pay}
            disabled={busy}
            className="lc-pill-primary text-xs shrink-0 disabled:opacity-50"
            data-testid="invoice-pay-btn"
          >
            {busy ? 'Pagando…' : 'Pagar'}
          </button>
        )}
      </span>
      <span className="mt-2 block text-[10px] text-lc-muted font-mono truncate" title={invoice}>
        {invoice.slice(0, 30)}…{invoice.slice(-10)}
      </span>
    </span>
  );
}

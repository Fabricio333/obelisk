'use client';

import { useState } from 'react';
import { useMessageZapStore, type ZapTarget } from '@/store/messageZap';
import { useToastStore } from '@/store/toast';
import { isWebLNAvailable, requestZapInvoice } from '@nostr-wot/wallet';
import { getDefaultRelays } from '@nostr-wot/data';
import { useNipSigner, useUserMetadata } from '@/lib/nostr-bridge';
import { getBridgeImpl, isImportableRelayUrl, useCurrentRelayUrl } from '@/lib/nostr-bridge';
import ModalShell from '@/components/ModalShell';

const QUICK_AMOUNTS = [21, 100, 500, 1000, 5000, 21000];

type WebLNProvider = {
  enable: () => Promise<void>;
  sendPayment: (paymentRequest: string) => Promise<unknown>;
};

export default function MessageZapModal() {
  const target = useMessageZapStore((s) => s.target);
  const close = useMessageZapStore((s) => s.close);

  if (!target) return null;

  const key = `${target.groupId}:${target.messageId ?? ''}:${target.recipientPubkey}:${target.defaultAmountSats ?? 100}`;
  return <MessageZapModalInner key={key} target={target} close={close} />;
}

function MessageZapModalInner({ target, close }: { target: ZapTarget; close: () => void }) {
  const [amount, setAmount] = useState<number>(target.defaultAmountSats ?? 100);
  const [comment, setComment] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const meta = useUserMetadata(target?.recipientPubkey ?? null);
  const signer = useNipSigner();
  const currentRelay = useCurrentRelayUrl();
  const lud16 = meta?.lud16 ?? target?.recipientLud16 ?? null;
  const displayName = target ? (meta?.displayName || meta?.name || target.displayName) : '';

  const send = async () => {
    if (!lud16) {
      setErr('This user has no Lightning address (lud16).');
      return;
    }
    if (!isWebLNAvailable()) {
      setErr('No WebLN extension detected. Install Alby (or similar) to zap.');
      return;
    }
    if (!amount || amount <= 0) {
      setErr('Enter a valid amount.');
      return;
    }
    if (!signer) {
      setErr('No active signer — log in first.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const webln = (window as unknown as { webln?: WebLNProvider }).webln;
      if (!webln) throw new Error('No WebLN extension detected. Install Alby (or similar) to zap.');
      await webln.enable();

      const relays = Array.from(new Set([
        ...(currentRelay ? [currentRelay] : []),
        ...getDefaultRelays(),
      ].filter(isImportableRelayUrl)));
      const amountMsats = amount * 1000;
      const { invoice, zapRequest } = await requestZapInvoice({
        getPublicKey: async () => signer.pubkey,
        signEvent: (template) => signer.signEvent(template),
      }, {
        recipientPubkey: target.recipientPubkey,
        lud16,
        eventId: target.messageId ?? undefined,
        amountMsats,
        relays,
        comment: comment.trim() || undefined,
      });

      await webln.sendPayment(invoice);

      const tags: string[][] = [
        ...(target.messageId ? [['e', target.messageId]] : []),
        ['p', target.recipientPubkey],
        ['h', target.groupId],
        ['amount', String(amountMsats), 'msat'],
        ['bolt11', invoice],
        ['description', JSON.stringify(zapRequest)],
      ];
      const bridge = getBridgeImpl();
      if (!bridge) throw new Error('Nostr bridge is not ready.');
      try {
        await bridge.publishEvent(
          {
            kind: 7,
            content: '⚡',
            tags,
          },
          currentRelay ? { extraRelays: [currentRelay] } : undefined,
        );
      } catch (publishErr) {
        useToastStore.getState().pushToast({
          title: `⚡ Sent ${amount.toLocaleString()} sats to ${displayName}`,
          body: `Payment succeeded, but the group zap marker was not published: ${(publishErr as Error).message}`,
        });
        close();
        return;
      }

      useToastStore.getState().pushToast({
        title: `⚡ Sent ${amount.toLocaleString()} sats to ${displayName}`,
        body: comment.trim() || '',
      });
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onClose={close}
      panelClassName="w-full max-w-md mx-4 rounded-xl border border-lc-border bg-lc-dark p-5"
    >
        <div className="mb-3 flex items-center gap-2">
          <BoltIcon className="h-5 w-5 text-yellow-400" />
          <h3 className="font-semibold text-lc-white">Zap {displayName}</h3>
        </div>
        <div className="mb-2 text-xs text-lc-muted">Amount (sats)</div>
        <input
          type="number"
          value={amount}
          min={1}
          autoFocus
          onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
          className="mb-3 w-full rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green"
        />
        <div className="mb-3 flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAmount(a)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                amount === a
                  ? 'border-yellow-400 bg-yellow-400 text-lc-black'
                  : 'border-lc-border text-lc-white hover:bg-lc-border/40'
              }`}
            >
              {a.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="mb-2 text-xs text-lc-muted">Comment (optional)</div>
        <input
          type="text"
          value={comment}
          maxLength={200}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Nice post!"
          className="mb-3 w-full rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green"
        />
        {err && <p className="mb-3 break-words text-xs text-red-400">{err}</p>}
        {!lud16 && (
          <p className="mb-3 text-xs text-yellow-400">Recipient has no Lightning address — zap will fail.</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="lc-pill-secondary text-xs">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={busy || !amount}
            className="inline-flex items-center gap-1 rounded-full bg-yellow-400 px-4 py-1.5 text-xs font-semibold text-lc-black hover:bg-yellow-300 disabled:opacity-50"
          >
            <BoltIcon className="h-3.5 w-3.5" />
            {busy ? 'Sending…' : `Zap ${amount.toLocaleString()} sats`}
          </button>
        </div>
    </ModalShell>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

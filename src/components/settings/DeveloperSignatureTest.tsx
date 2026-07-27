'use client';

import { useState } from 'react';
import { nostrActions, useSignerReady } from '@/lib/nostr-bridge';
import { OBELISK_SIGNING_KINDS } from '@/lib/nostr-signing-kinds';

type Result = 'pending' | 'accepted' | 'rejected';

export default function DeveloperSignatureTest({ mobile = false }: { mobile?: boolean }) {
  const signerReady = useSignerReady();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<number, Result>>({});

  const run = async () => {
    setRunning(true);
    setResults(Object.fromEntries(OBELISK_SIGNING_KINDS.map((kind) => [kind, 'pending'])));
    await Promise.all(OBELISK_SIGNING_KINDS.map(async (kind) => {
      try {
        await nostrActions.signEventTemplate({
          kind,
          content: kind === 22242 ? '' : `Obelisk mock signature test for kind ${kind}. This event is not published.`,
          tags: kind === 22242
            ? [['relay', 'wss://public.obelisk.ar'], ['challenge', 'obelisk-developer-signature-test'], ['client', 'Obelisk']]
            : [['client', 'Obelisk'], ['alt', 'Developer signature permission test']],
        });
        setResults((current) => ({ ...current, [kind]: 'accepted' }));
      } catch {
        setResults((current) => ({ ...current, [kind]: 'rejected' }));
      }
    }));
    setRunning(false);
  };

  const accepted = Object.values(results).filter((result) => result === 'accepted').length;
  const rejected = Object.values(results).filter((result) => result === 'rejected').length;
  const requested = Object.keys(results).length;

  return (
    <details className={mobile ? 'settings-section' : 'rounded-lg border border-lc-border bg-lc-dark/30 p-3'} data-testid="developer-signature-test">
      <summary className={mobile ? 'settings-section-title cursor-pointer' : 'cursor-pointer text-xs font-semibold uppercase tracking-wider text-lc-muted'}>
        Developer settings
      </summary>
      <div className={mobile ? 'settings-row !block' : 'mt-3 space-y-3'}>
        <div className={mobile ? 'settings-row-meta muted' : 'text-xs text-lc-muted'}>
          Request mock signatures for every event kind Obelisk uses. Signed events are discarded and never published.
        </div>
        <button
          type="button"
          disabled={!signerReady || running}
          onClick={() => void run()}
          className={mobile ? 'settings-btn-secondary mt-3 w-full' : 'rounded-md border border-lc-green/50 bg-lc-green/10 px-3 py-2 text-sm font-semibold text-lc-green hover:bg-lc-green/20 disabled:opacity-50'}
          data-testid="request-mock-signatures"
        >
          {running ? `Waiting · ${accepted + rejected}/${OBELISK_SIGNING_KINDS.length}` : `Request all ${OBELISK_SIGNING_KINDS.length} signatures`}
        </button>
        {requested > 0 && !running && (
          <div className={mobile ? 'settings-row-meta muted mt-2' : 'text-xs text-lc-muted'} role="status">
            {accepted} accepted · {rejected} rejected
          </div>
        )}
      </div>
    </details>
  );
}

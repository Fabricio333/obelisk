'use client';

import ErrorPanel from '@/components/ErrorPanel';

/**
 * Route-level error boundary for everything under the root layout — the
 * chat shell included.
 *
 * Before this existed, a single render throw anywhere in the client tree
 * (a malformed event, a bad `nostr:` URI, an unparseable invoice) unmounted
 * the whole app and left Next's bare "Application error: a client-side
 * exception has occurred" screen, with a manual reload as the only way
 * back. Now the failure is contained and `reset()` re-renders the segment
 * without a full page load.
 *
 * The root layout keeps rendering around this, so the toast stack and
 * locale provider survive.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorPanel error={error} reset={reset} />;
}

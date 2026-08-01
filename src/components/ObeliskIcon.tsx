'use client';

/**
 * Buenos Aires Obelisco icon — uses currentColor so it adapts to any theme.
 *
 * Traced from the shipped app icon (`public/icon-512.png`): a symmetric
 * silhouette with the slim left face cut out, so the background reads through
 * it exactly as it does in the icon and the favicon. The older
 * `public/obelisk.png` artwork this was previously traced from is deprecated —
 * both of its faces were solid and it sat ~8% wider at the base.
 */
export default function ObeliskIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={className}
      aria-hidden="true"
    >
      {/* Outer silhouette, then the hollow left face as a second subpath. */}
      <path d="
        M 256,16
        L 291.71,61.58
        L 311.61,464
        L 200.39,464
        L 220.29,61.58
        Z
        M 251.04,37.85
        L 230.28,64.27
        L 210.53,454.57
        L 251.04,454.57
        Z
      " />
    </svg>
  );
}

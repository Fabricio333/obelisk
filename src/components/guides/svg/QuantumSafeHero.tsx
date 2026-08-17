export default function QuantumSafeHero() {
  return (
    <svg
      viewBox="0 0 800 400"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby="hero-quantum-safe-title hero-quantum-safe-desc"
      className="w-full h-auto"
    >
      <title id="hero-quantum-safe-title">A message sealed by two layers of protection</title>
      <desc id="hero-quantum-safe-desc">
        A classic Nostr key exchange wrapped in an outer post-quantum shell, with a
        locked envelope at the center representing a hybrid-protected direct message.
      </desc>

      <defs>
        <radialGradient id="bg-quantum-safe" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0%" stopColor="#1e2812" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </radialGradient>
        <radialGradient id="quantum-safe-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#b4f953" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#b4f953" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="800" height="400" fill="url(#bg-quantum-safe)" />

      {/* soft glow behind the sealed message */}
      <circle
        cx="400"
        cy="200"
        r="150"
        fill="url(#quantum-safe-glow)"
        className="animate-glow-pulse"
        style={{ transformOrigin: '400px 200px', transformBox: 'fill-box' } as React.CSSProperties}
      />

      {/* outer shell: the post-quantum layer wrapping the classic one */}
      <rect
        x="150" y="80" width="500" height="240" rx="28"
        fill="none" stroke="#b4f953" strokeOpacity="0.35" strokeWidth="2"
      />
      {/* inner shell: the classic secp256k1 key exchange */}
      <rect
        x="220" y="130" width="360" height="140" rx="18"
        fill="none" stroke="#b4f953" strokeOpacity="0.75" strokeWidth="2"
      />

      {/* sealed envelope at the center */}
      <circle cx="400" cy="200" r="32" fill="#b4f953" fillOpacity="0.14" stroke="#b4f953" strokeWidth="2" />
      <path
        d="M388 198v-10a12 12 0 0 1 24 0v10" fill="none"
        stroke="#b4f953" strokeWidth="2.4" strokeLinecap="round"
      />
      <rect x="385" y="198" width="30" height="22" rx="5" fill="#b4f953" fillOpacity="0.85" />

      {/* legend */}
      <g fontSize="11" fontWeight="600">
        <rect x="40" y="18" width="16" height="12" rx="3" fill="none" stroke="#b4f953" strokeOpacity="0.75" strokeWidth="1.5" />
        <text x="64" y="28" fill="#fafafa">classic key exchange</text>
        <rect x="230" y="18" width="16" height="12" rx="3" fill="none" stroke="#b4f953" strokeOpacity="0.35" strokeWidth="1.5" />
        <text x="254" y="28" fill="#fafafa">post-quantum layer</text>
      </g>
    </svg>
  );
}

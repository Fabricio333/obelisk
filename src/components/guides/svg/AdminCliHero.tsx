export default function AdminCliHero() {
  const lines = [
    { text: '$ npm run admin -- login --bunker bunker://...', color: '#a3a3a3', delay: '0s' },
    { text: '✓ authenticated as npub1agent…', color: '#b4f953', delay: '0.6s' },
    { text: '$ npm run admin -- servers list', color: '#a3a3a3', delay: '1.2s' },
    { text: '→ obelisk.ar · la-crypta · test-server', color: '#fafafa', delay: '1.8s' },
    { text: '$ npm run admin -- channels create sv1 …', color: '#a3a3a3', delay: '2.4s' },
    { text: '✓ #announcements created', color: '#b4f953', delay: '3.0s' },
  ];

  return (
    <svg
      viewBox="0 0 800 400"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby="hero-cli-title hero-cli-desc"
      className="w-full h-auto"
    >
      <title id="hero-cli-title">Admin CLI for coding agents</title>
      <desc id="hero-cli-desc">
        A terminal window streaming admin commands, wired to an AI agent avatar that signs
        Nostr challenges and publishes NIP-29 events to the relay.
      </desc>

      <defs>
        <linearGradient id="sky-cli" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a0a0a" />
          <stop offset="100%" stopColor="#0f1a08" />
        </linearGradient>
        <radialGradient id="agent-glow" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0%" stopColor="#b4f953" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#b4f953" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="800" height="400" fill="url(#sky-cli)" />

      {/* faint grid */}
      <g opacity="0.1" stroke="#b4f953" strokeWidth="0.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={40 + i * 40} x2="800" y2={40 + i * 40} />
        ))}
      </g>

      {/* terminal window */}
      <g>
        <rect x="180" y="60" width="440" height="280" rx="12" fill="#0f0f0f" stroke="#b4f953" strokeWidth="1.6" />
        {/* title bar */}
        <rect x="180" y="60" width="440" height="28" rx="12" fill="#171717" />
        <rect x="180" y="74" width="440" height="14" fill="#171717" />
        <circle cx="198" cy="74" r="5" fill="#b45353" />
        <circle cx="214" cy="74" r="5" fill="#f7b32b" />
        <circle cx="230" cy="74" r="5" fill="#b4f953" />
        <text x="400" y="78" textAnchor="middle" fontSize="11" fontWeight="600" fill="#a3a3a3" fontFamily="monospace">
          obelisk admin cli
        </text>

        {/* log lines with fade-in */}
        <g fontFamily="monospace" fontSize="12">
          {lines.map((ln, i) => (
            <text
              key={i}
              x="200"
              y={110 + i * 32}
              fill={ln.color}
              className="animate-fade-in-up"
              style={{ animationDelay: ln.delay, animationFillMode: 'both' } as React.CSSProperties}
            >
              {ln.text}
            </text>
          ))}

          {/* blinking cursor */}
          <rect x="200" y={110 + lines.length * 32 - 11} width="9" height="14" fill="#b4f953" className="animate-dot-pulse">
            <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />
          </rect>
        </g>
      </g>

      {/* agent avatar (left) */}
      <g>
        <circle cx="90" cy="200" r="56" fill="url(#agent-glow)"
          className="animate-glow-pulse"
          style={{ transformOrigin: '90px 200px', transformBox: 'fill-box' } as React.CSSProperties}
        />
        <rect x="54" y="164" width="72" height="72" rx="14" fill="#171717" stroke="#b4f953" strokeWidth="1.8" />
        {/* robot eyes */}
        <circle cx="76" cy="196" r="5" fill="#b4f953">
          <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="104" cy="196" r="5" fill="#b4f953">
          <animate attributeName="opacity" values="1;0.3;1" dur="2s" begin="0.3s" repeatCount="indefinite" />
        </circle>
        {/* antenna */}
        <line x1="90" y1="164" x2="90" y2="148" stroke="#b4f953" strokeWidth="1.8" />
        <circle cx="90" cy="144" r="4" fill="#b4f953" className="animate-dot-pulse"
          style={{ transformOrigin: '90px 144px' } as React.CSSProperties}
        />
        {/* mouth */}
        <rect x="78" y="212" width="24" height="4" rx="2" fill="#b4f953" opacity="0.7" />
        <text x="90" y="276" textAnchor="middle" fontSize="11" fontWeight="600" fill="#a3a3a3" fontFamily="monospace">
          AI agent
        </text>
      </g>

      {/* Obelisk server card (right) */}
      <g>
        <rect x="670" y="150" width="90" height="100" rx="12" fill="#171717" stroke="#b4f953" strokeWidth="1.6" />
        <polygon points="715,168 705,232 725,232" fill="#b4f953" opacity="0.85" />
        <rect x="700" y="232" width="30" height="4" fill="#b4f953" opacity="0.7" />
        <text x="715" y="268" textAnchor="middle" fontSize="11" fontWeight="600" fill="#a3a3a3" fontFamily="monospace">
          NIP-29 relay
        </text>
      </g>

      {/* flow: agent → terminal → server */}
      <g stroke="#b4f953" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.9">
        <line
          x1="130" y1="200" x2="180" y2="200"
          strokeDasharray="4 10"
          className="animate-dash-flow"
        />
        <line
          x1="620" y1="200" x2="670" y2="200"
          strokeDasharray="4 10"
          className="animate-dash-flow"
          style={{ animationDelay: '0.4s' } as React.CSSProperties}
        />
      </g>

      {/* signed-challenge badge */}
      <g>
        <rect x="320" y="348" width="160" height="26" rx="13" fill="#0a0a0a" stroke="#b4f953" strokeWidth="1.5" />
        <text x="400" y="365" textAnchor="middle" fontSize="11" fontWeight="700" fill="#b4f953" fontFamily="monospace">
          signed with nsec / NIP-46
        </text>
      </g>

      {/* legend */}
      <g fontSize="11" fontWeight="600">
        <rect x="34" y="18" width="12" height="12" rx="2" fill="#b4f953" />
        <text x="52" y="28" fill="#fafafa">relay-authorized events</text>
        <rect x="220" y="18" width="12" height="12" rx="2" fill="#171717" stroke="#b4f953" strokeWidth="1.5" />
        <text x="238" y="28" fill="#fafafa">same NIP-29 protocol</text>
      </g>
    </svg>
  );
}

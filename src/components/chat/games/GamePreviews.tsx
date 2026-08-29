/**
 * Thumbnails for the game picker.
 *
 * Each one is a fixed mid-game snapshot drawn in the real board's colours, so
 * the picker shows what you are about to get rather than a generic icon. The
 * Chain Reaction preview is ported from the classic stack; the Vesta one is
 * new, and uses the same resource palette as the live board.
 */

export function ChainReactionPreview({ size = 56 }: { size?: number }) {
  const cols = 4;
  const rows = 5;
  const gap = 1.5;
  const cell = (size - gap * (cols - 1)) / cols;
  // [cellIndex, orbCount, colorIdx]
  const stamps: Array<[number, number, number]> = [
    [0, 1, 0], [2, 2, 1], [3, 1, 1],
    [5, 3, 0], [6, 1, 2],
    [9, 2, 2], [10, 1, 0],
    [13, 1, 1], [14, 2, 3],
    [17, 1, 3], [18, 1, 0],
  ];
  const palette = ['#ef4444', '#b4f953', '#60a5fa', '#facc15'];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Chain Reaction preview"
      className="shrink-0"
    >
      <rect x={0} y={0} width={size} height={size} rx={4} ry={4} fill="#0a0a0a" />
      {Array.from({ length: cols * rows }, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * (cell + gap);
        const y = row * (cell + gap);
        const stamp = stamps.find(([idx]) => idx === i);
        return (
          <g key={i}>
            <rect x={x} y={y} width={cell} height={cell} rx={2} ry={2} fill="#171717" stroke="#262626" strokeWidth={0.5} />
            {stamp && <OrbGroup x={x} y={y} cell={cell} count={stamp[1]} color={palette[stamp[2]]} />}
          </g>
        );
      })}
    </svg>
  );
}

function OrbGroup({ x, y, cell, count, color }: { x: number; y: number; cell: number; count: number; color: string }) {
  const cx = x + cell / 2;
  const cy = y + cell / 2;
  const r = cell * 0.16;
  const offsets: Array<[number, number]> =
    count === 1 ? [[0, 0]]
    : count === 2 ? [[-r, 0], [r, 0]]
    : [[-r, r * 0.7], [r, r * 0.7], [0, -r]];
  return (
    <g>
      {offsets.map(([dx, dy], i) => (
        <circle key={i} cx={cx + dx} cy={cy + dy} r={r} fill={color} />
      ))}
    </g>
  );
}

export function VestaPreview({ size = 56 }: { size?: number }) {
  // Seven hexes in a flower, in the board's own resource colours, with two
  // settlements on the vertices between them.
  const r = size * 0.17;
  const cx = size / 2;
  const cy = size / 2;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  const hexes: Array<[number, number, string]> = [
    [0, 0, '#d6bd8a'],
    [0, -2 * dy, '#15803d'],
    [dx, -dy, '#ca8a04'],
    [dx, dy, '#b45309'],
    [0, 2 * dy, '#57534e'],
    [-dx, dy, '#a8a29e'],
    [-dx, -dy, '#15803d'],
  ];

  const points = (ox: number, oy: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const angle = (Math.PI / 180) * (60 * i - 90);
      return `${cx + ox + r * Math.cos(angle)},${cy + oy + r * Math.sin(angle)}`;
    }).join(' ');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Vesta preview"
      className="shrink-0"
    >
      <rect x={0} y={0} width={size} height={size} rx={4} ry={4} fill="#0a1628" />
      {hexes.map(([ox, oy, fill], i) => (
        <polygon key={i} points={points(ox, oy)} fill={fill} stroke="#0a0a0a" strokeWidth={0.8} />
      ))}
      {/* A road and two settlements, in two players' colours. */}
      <line
        x1={cx - dx * 0.5} y1={cy - dy * 0.5} x2={cx + dx * 0.5} y2={cy - dy * 0.5}
        stroke="#e07b30" strokeWidth={size * 0.05} strokeLinecap="round"
      />
      <circle cx={cx - dx * 0.5} cy={cy - dy * 0.5} r={size * 0.055} fill="#e07b30" stroke="#fff" strokeWidth={0.8} />
      <circle cx={cx + dx * 0.5} cy={cy + dy * 1.5} r={size * 0.055} fill="#3498db" stroke="#fff" strokeWidth={0.8} />
    </svg>
  );
}

/** Thumbnail for a game type, falling back to its catalog glyph. */
export function GameTypePreview({ type, size = 56, icon }: { type: string; size?: number; icon?: string }) {
  if (type === 'chain-reaction') return <ChainReactionPreview size={size} />;
  if (type === 'vesta') return <VestaPreview size={size} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-lc-border/40 text-2xl"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {icon ?? '🎲'}
    </span>
  );
}

/**
 * Board geometry for rendering, rebuilt from upstream's exported primitives.
 *
 * Vesta keeps its vertex/edge caches module-private, but every ingredient is
 * exported: `BOARD_HEXES`, `hexCornerPixel`, `vertexKey`, `edgeKey`. Deriving
 * our map from those means the keys we draw are the same strings upstream's
 * rules produce — the renderer cannot drift from the engine, because it is
 * asking the engine where things are.
 */
import {
  BOARD_HEXES,
  hexCornerPixel,
  hexToPixel,
  vertexKey,
  edgeKey,
  type HexCoord,
} from 'vesta';

export interface VertexNode {
  key: string;
  x: number;
  y: number;
  /** Every (hex, corner) that lands on this point — any one identifies it. */
  hexes: Array<{ q: number; r: number; corner: number }>;
}

export interface EdgeNode {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The hex + corner pair the engine wants for a `place-road` move. */
  hex: { q: number; r: number; c1: number; c2: number };
}

let vertexCache: Map<string, VertexNode> | null = null;
let edgeCache: Map<string, EdgeNode> | null = null;

function build(): void {
  if (vertexCache && edgeCache) return;
  const vertices = new Map<string, VertexNode>();
  const edges = new Map<string, EdgeNode>();

  for (const hex of BOARD_HEXES) {
    for (let corner = 0; corner < 6; corner++) {
      const px = hexCornerPixel(hex.q, hex.r, corner);
      const key = vertexKey(hex.q, hex.r, corner);
      const existing = vertices.get(key);
      if (existing) {
        existing.hexes.push({ q: hex.q, r: hex.r, corner });
      } else {
        vertices.set(key, { key, x: px.x, y: px.y, hexes: [{ q: hex.q, r: hex.r, corner }] });
      }

      const nextCorner = (corner + 1) % 6;
      const ek = edgeKey(hex.q, hex.r, corner, hex.q, hex.r, nextCorner);
      if (!edges.has(ek)) {
        const p2 = hexCornerPixel(hex.q, hex.r, nextCorner);
        edges.set(ek, {
          key: ek,
          x1: px.x,
          y1: px.y,
          x2: p2.x,
          y2: p2.y,
          hex: { q: hex.q, r: hex.r, c1: corner, c2: nextCorner },
        });
      }
    }
  }

  vertexCache = vertices;
  edgeCache = edges;
}

export function vertices(): Map<string, VertexNode> {
  build();
  return vertexCache!;
}

export function edges(): Map<string, EdgeNode> {
  build();
  return edgeCache!;
}

export function vertexAt(key: string): VertexNode | null {
  return vertices().get(key) ?? null;
}

export function edgeAt(key: string): EdgeNode | null {
  return edges().get(key) ?? null;
}

/** Corner points of a hex, for filling the tile. */
export function hexPolygon(hex: HexCoord): Array<{ x: number; y: number }> {
  return Array.from({ length: 6 }, (_, c) => hexCornerPixel(hex.q, hex.r, c));
}

export function hexCenter(hex: HexCoord): { x: number; y: number } {
  return hexToPixel(hex.q, hex.r);
}

/** Nearest vertex to a point, within `maxDistance` pixels. */
export function nearestVertex(x: number, y: number, maxDistance: number): VertexNode | null {
  let best: VertexNode | null = null;
  let bestD = maxDistance * maxDistance;
  for (const v of vertices().values()) {
    const d = (v.x - x) ** 2 + (v.y - y) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Nearest edge midpoint to a point, within `maxDistance` pixels. */
export function nearestEdge(x: number, y: number, maxDistance: number): EdgeNode | null {
  let best: EdgeNode | null = null;
  let bestD = maxDistance * maxDistance;
  for (const e of edges().values()) {
    const mx = (e.x1 + e.x2) / 2;
    const my = (e.y1 + e.y2) / 2;
    const d = (mx - x) ** 2 + (my - y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Hex whose center is nearest a point — used for placing the robber. */
export function nearestHex(x: number, y: number, maxDistance: number): HexCoord | null {
  let best: HexCoord | null = null;
  let bestD = maxDistance * maxDistance;
  for (const hex of BOARD_HEXES) {
    const c = hexCenter(hex);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) { bestD = d; best = hex; }
  }
  return best;
}

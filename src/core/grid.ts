/**
 * Occupancy analysis.
 *
 * The plan is rasterised at 50 mm, every wall, window and piece of furniture is
 * burned in as an obstacle, and an exact Euclidean distance transform gives the
 * clear radius available at every point of floor. From that one field we get
 * turning circles, effective doorway widths and — via a flood fill constrained
 * by radius — which parts of the home a wheelchair user can actually reach.
 *
 * This is the number the agent cannot bluff: it either measures up, or it does
 * not, and the tool result says by how much.
 */

import {
  doorSwingRect,
  furnitureRect,
  openingRect,
  planBounds,
  roomRect,
  wallSegments,
  wallPoint,
} from './geometry';
import type { Plan, Rect, Room } from './types';

export const CELL = 50; // mm

export interface Grid {
  cell: number;
  /** World mm of the grid's top-left corner. */
  ox: number;
  oy: number;
  cols: number;
  rows: number;
  /** 1 where the cell is inside some room. */
  floor: Uint8Array;
  /** 1 where a wall, window or object blocks passage. */
  blocked: Uint8Array;
  /** Clear radius in mm at each cell; 0 on obstacles. */
  clearance: Float32Array;
}

export interface Reachability {
  /** 1 on every square of floor a body of that radius sweeps on its way round. */
  mask: Uint8Array;
  /** 1 only where the *centre* of that body can sit. */
  centres: Uint8Array;
  /** Reachable floor area, m². */
  areaM2: number;
  /** Total floor area, m². */
  totalM2: number;
  /** reachable / total, 0..1. */
  ratio: number;
  /** Cell index the flood started from, or -1 when no entry was found. */
  seed: number;
}

function idx(g: Grid, cx: number, cy: number): number {
  return cy * g.cols + cx;
}

function fillRect(g: Grid, r: Rect, target: Uint8Array, value: number): void {
  const x0 = Math.max(0, Math.floor((r.x - g.ox) / g.cell));
  const y0 = Math.max(0, Math.floor((r.y - g.oy) / g.cell));
  const x1 = Math.min(g.cols - 1, Math.ceil((r.x + r.w - g.ox) / g.cell) - 1);
  const y1 = Math.min(g.rows - 1, Math.ceil((r.y + r.h - g.oy) / g.cell) - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) target[idx(g, x, y)] = value;
  }
}

/** Builds the occupancy grid for a plan. Cheap enough to run on every edit. */
export function rasterise(plan: Plan, cell = CELL): Grid {
  const b = planBounds(plan);
  const margin = plan.settings.exteriorWall + cell * 4;
  const ox = b.x - margin;
  const oy = b.y - margin;
  const cols = Math.ceil((b.w + margin * 2) / cell);
  const rows = Math.ceil((b.h + margin * 2) / cell);
  const n = cols * rows;
  const g: Grid = {
    cell,
    ox,
    oy,
    cols,
    rows,
    floor: new Uint8Array(n),
    blocked: new Uint8Array(n),
    clearance: new Float32Array(n),
  };

  for (const room of plan.rooms) fillRect(g, roomRect(room), g.floor, 1);

  // Walls: a band straddling every wall stretch. Interior partitions are thin,
  // anything facing outdoors gets the full envelope thickness.
  for (const seg of wallSegments(plan)) {
    const room = plan.rooms.find((r) => r.id === seg.roomId);
    if (!room) continue;
    const t = seg.neighbourId ? plan.settings.interiorWall : plan.settings.exteriorWall;
    const a = wallPoint(room, seg.side, seg.start);
    const bpt = wallPoint(room, seg.side, seg.end);
    const horizontal = seg.side === 'n' || seg.side === 's';
    const band: Rect = horizontal
      ? { x: a.x, y: a.y - t / 2, w: bpt.x - a.x, h: t }
      : { x: a.x - t / 2, y: a.y, w: t, h: bpt.y - a.y };
    fillRect(g, band, g.blocked, 1);
  }

  // Carve the holes back out. Windows stay solid — you cannot walk through one.
  for (const op of plan.openings) {
    if (op.kind === 'window') continue;
    const r = openingRect(plan, op);
    if (r) fillRect(g, growAcross(r, op.side === 'n' || op.side === 's', cell), g.blocked, 0);
  }

  for (const f of plan.furniture) fillRect(g, furnitureRect(f), g.blocked, 1);

  computeClearance(g);
  return g;
}

/**
 * Extends a wall opening through the wall's thickness only, never sideways, so
 * carving a door never widens the hole past its real reveal.
 */
function growAcross(r: Rect, horizontalWall: boolean, amount: number): Rect {
  return horizontalWall
    ? { x: r.x, y: r.y - amount, w: r.w, h: r.h + amount * 2 }
    : { x: r.x - amount, y: r.y, w: r.w + amount * 2, h: r.h };
}

const INF = 1e20;

/** Felzenszwalb & Huttenlocher's exact squared-distance transform, 1D pass. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s =
      (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = dx * dx + f[v[k]!]!;
  }
}

/**
 * Distance in mm from every cell to the nearest seed cell. Used twice: with
 * obstacles as seeds it gives the clearance field, and with the reachable set
 * as seeds it gives the area a body of that radius actually sweeps.
 */
function distanceField(g: Grid, isSeed: (i: number) => boolean): Float32Array {
  const n = g.cols * g.rows;
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) sq[i] = isSeed(i) ? 0 : INF;

  const maxDim = Math.max(g.cols, g.rows);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < g.cols; x++) {
    for (let y = 0; y < g.rows; y++) f[y] = sq[y * g.cols + x]!;
    edt1d(f, g.rows, d, v, z);
    for (let y = 0; y < g.rows; y++) sq[y * g.cols + x] = d[y]!;
  }
  for (let y = 0; y < g.rows; y++) {
    const row = y * g.cols;
    for (let x = 0; x < g.cols; x++) f[x] = sq[row + x]!;
    edt1d(f, g.cols, d, v, z);
    for (let x = 0; x < g.cols; x++) sq[row + x] = d[x]!;
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(sq[i]!) * g.cell;
  return out;
}

function computeClearance(g: Grid): void {
  const field = distanceField(g, (i) => !(g.floor[i] === 1 && g.blocked[i] === 0));
  for (let i = 0; i < g.cols * g.rows; i++) {
    g.clearance[i] = g.floor[i] === 1 && g.blocked[i] === 0 ? field[i]! : 0;
  }
}

export function clearanceAt(g: Grid, x: number, y: number): number {
  const cx = Math.floor((x - g.ox) / g.cell);
  const cy = Math.floor((y - g.oy) / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return 0;
  return g.clearance[idx(g, cx, cy)]!;
}

/** Largest clear radius anywhere inside a rectangle, mm. */
export function maxClearanceIn(g: Grid, r: Rect): { value: number; x: number; y: number } {
  const x0 = Math.max(0, Math.floor((r.x - g.ox) / g.cell));
  const y0 = Math.max(0, Math.floor((r.y - g.oy) / g.cell));
  const x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w - g.ox) / g.cell));
  const y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h - g.oy) / g.cell));
  let best = 0;
  let bx = r.x + r.w / 2;
  let by = r.y + r.h / 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = g.clearance[idx(g, x, y)]!;
      if (c > best) {
        best = c;
        bx = g.ox + (x + 0.5) * g.cell;
        by = g.oy + (y + 0.5) * g.cell;
      }
    }
  }
  return { value: best, x: bx, y: by };
}

/**
 * Where a body of the given radius can get to, starting from the front door.
 * Doorways narrower than the body simply do not connect, which is exactly the
 * failure mode this whole app exists to surface.
 */
export function reachableFrom(
  plan: Plan,
  g: Grid,
  radius: number,
  seedPoint?: { x: number; y: number },
): Reachability {
  const n = g.cols * g.rows;
  const mask = new Uint8Array(n);
  const cellM2 = (g.cell * g.cell) / 1_000_000;
  // Only bare floor counts towards the total. Walls and the footprints of
  // furniture are not somewhere anyone was ever going to stand.
  let total = 0;
  for (let i = 0; i < n; i++) if (g.floor[i] === 1 && g.blocked[i] === 0) total++;

  const found = seedPoint ?? entryPoint(plan, g);
  const start = found ? { x: found.x, y: found.y } : null;
  if (!start) {
    return { mask, centres: mask, areaM2: 0, totalM2: total * cellM2, ratio: 0, seed: -1 };
  }
  const sx = Math.floor((start.x - g.ox) / g.cell);
  const sy = Math.floor((start.y - g.oy) / g.cell);
  if (sx < 0 || sy < 0 || sx >= g.cols || sy >= g.rows) {
    return { mask, centres: mask, areaM2: 0, totalM2: total * cellM2, ratio: 0, seed: -1 };
  }

  const seed = idx(g, sx, sy);
  const passable = (i: number) => g.clearance[i]! >= radius;
  if (!passable(seed)) {
    // Nudge to the roomiest cell nearby so a tight entry mat does not abort the run.
    const near = maxClearanceIn(g, {
      x: start.x - 1200,
      y: start.y - 1200,
      w: 2400,
      h: 2400,
    });
    if (near.value < radius) {
      return { mask, centres: mask, areaM2: 0, totalM2: total * cellM2, ratio: 0, seed: -1 };
    }
    start.x = near.x;
    start.y = near.y;
  }

  const s = idx(
    g,
    Math.floor((start.x - g.ox) / g.cell),
    Math.floor((start.y - g.oy) / g.cell),
  );
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = s;
  mask[s] = 1;
  while (head < tail) {
    const cur = queue[head++]!;
    const cx = cur % g.cols;
    const cy = (cur - cx) / g.cols;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
      const ni = ny * g.cols + nx;
      if (mask[ni] || !passable(ni)) continue;
      mask[ni] = 1;
      queue[tail++] = ni;
    }
  }
  // The flood fill tracks where the *centre* of the body can go. What matters
  // to a person is the floor that body sweeps, so grow the result by its radius
  // and count that instead.
  const spread = distanceField(g, (i) => mask[i] === 1);
  const swept = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (g.floor[i] !== 1 || g.blocked[i] === 1) continue;
    if (spread[i]! <= radius) {
      swept[i] = 1;
      count++;
    }
  }

  const areaM2 = count * cellM2;
  const totalM2 = total * cellM2;
  return { mask: swept, centres: mask, areaM2, totalM2, ratio: totalM2 ? areaM2 / totalM2 : 0, seed: s };
}

/** The centre of the first exterior door, which is where a visitor arrives. */
export function entryPoint(plan: Plan, g: Grid): { x: number; y: number } | null {
  const doors = plan.openings.filter((o) => o.kind === 'door');
  for (const d of doors) {
    const r = openingRect(plan, d);
    if (!r) continue;
    const inside = plan.rooms.find((room) => room.id === d.roomId);
    if (!inside) continue;
    // Step one cell inside the room so the seed lands on floor, not in the wall.
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const toCentre = {
      x: inside.x + inside.w / 2 - c.x,
      y: inside.y + inside.h / 2 - c.y,
    };
    const len = Math.hypot(toCentre.x, toCentre.y) || 1;
    const p = {
      x: c.x + (toCentre.x / len) * (plan.settings.exteriorWall + g.cell * 2),
      y: c.y + (toCentre.y / len) * (plan.settings.exteriorWall + g.cell * 2),
    };
    if (clearanceAt(g, p.x, p.y) > 0) return p;
  }
  const biggest = [...plan.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!biggest) return null;
  const m = maxClearanceIn(g, roomRect(biggest));
  return { x: m.x, y: m.y };
}

/** Fraction of a room the flood fill actually reached. */
export function roomReachRatio(g: Grid, reach: Reachability, room: Room): number {
  const r = roomRect(room);
  const x0 = Math.max(0, Math.floor((r.x - g.ox) / g.cell));
  const y0 = Math.max(0, Math.floor((r.y - g.oy) / g.cell));
  const x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w - g.ox) / g.cell));
  const y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h - g.oy) / g.cell));
  let floorCells = 0;
  let hit = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = idx(g, x, y);
      if (g.floor[i] !== 1 || g.blocked[i] === 1) continue;
      floorCells++;
      if (reach.mask[i]) hit++;
    }
  }
  return floorCells ? hit / floorCells : 0;
}

/**
 * Effective clear width at a doorway, mm — the structural width minus whatever
 * furniture or door leaf actually intrudes into it.
 */
export function doorClearWidth(plan: Plan, g: Grid, openingId: string): number {
  const op = plan.openings.find((o) => o.id === openingId);
  if (!op) return 0;
  const r = openingRect(plan, op);
  if (!r) return 0;

  // Walk straight across the reveal and take the longest unobstructed run. This
  // measures the hole itself — furniture parked *in front of* a door is a
  // different failure, and a different rule.
  const horizontal = op.side === 'n' || op.side === 's';
  const midX = r.x + r.w / 2;
  const midY = r.y + r.h / 2;
  const from = horizontal ? r.x : r.y;
  const to = horizontal ? r.x + r.w : r.y + r.h;

  let best = 0;
  let run = 0;
  for (let t = from + g.cell / 2; t < to; t += g.cell) {
    const cx = Math.floor(((horizontal ? t : midX) - g.ox) / g.cell);
    const cy = Math.floor(((horizontal ? midY : t) - g.oy) / g.cell);
    const inside = cx >= 0 && cy >= 0 && cx < g.cols && cy < g.rows;
    const clear = inside && g.blocked[cy * g.cols + cx] === 0;
    run = clear ? run + g.cell : 0;
    if (run > best) best = run;
  }

  // A hinged leaf parked in the reveal eats roughly its own thickness.
  const leaf = op.kind === 'door' && op.swing !== 'none' ? 40 : 0;
  return Math.max(0, Math.min(op.width, best) - leaf);
}

/** Rectangles the door leaves sweep, for both drawing and clash detection. */
export function swingRects(plan: Plan): { id: string; rect: Rect }[] {
  const out: { id: string; rect: Rect }[] = [];
  for (const op of plan.openings) {
    const r = doorSwingRect(plan, op);
    if (r) out.push({ id: op.id, rect: r });
  }
  return out;
}

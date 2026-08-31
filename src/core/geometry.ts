/**
 * Pure geometry helpers. No DOM, no state — everything here is a function of a
 * Plan, which is what lets the rule engine and the WebMCP tools share one
 * source of truth about where things actually are.
 */

import type {
  Furniture,
  Opening,
  Plan,
  Rect,
  Room,
  Side,
  WallSegment,
} from './types';

export const SIDES: Side[] = ['n', 'e', 's', 'w'];

export const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

export const SIDE_LABEL: Record<Side, string> = {
  n: 'north',
  e: 'east',
  s: 'south',
  w: 'west',
};

/** Unit vector pointing away from the room through the given wall (y grows south). */
export const SIDE_NORMAL: Record<Side, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

export function roomRect(r: Room): Rect {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

export function rectRight(r: Rect): number {
  return r.x + r.w;
}
export function rectBottom(r: Rect): number {
  return r.y + r.h;
}
export function rectCentre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
export function rectArea(r: Rect): number {
  return r.w * r.h;
}

export function rectsOverlap(a: Rect, b: Rect, tolerance = 0): boolean {
  return (
    a.x + a.w - tolerance > b.x &&
    b.x + b.w - tolerance > a.x &&
    a.y + a.h - tolerance > b.y &&
    b.y + b.h - tolerance > a.y
  );
}

export function overlapRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(rectRight(a), rectRight(b)) - x;
  const h = Math.min(rectBottom(a), rectBottom(b)) - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function planBounds(plan: Plan): Rect {
  if (plan.rooms.length === 0) return { x: 0, y: 0, w: 10000, h: 8000 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of plan.rooms) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Length of a room's wall on the given side, mm. */
export function wallLength(room: Room, side: Side): number {
  return side === 'n' || side === 's' ? room.w : room.h;
}

/**
 * Converts an offset along a wall into world coordinates.
 * Offsets always run left-to-right for n/s walls and top-to-bottom for e/w
 * walls, so "offset 0" is unambiguous no matter which room owns the wall.
 */
export function wallPoint(room: Room, side: Side, offset: number): { x: number; y: number } {
  switch (side) {
    case 'n':
      return { x: room.x + offset, y: room.y };
    case 's':
      return { x: room.x + offset, y: room.y + room.h };
    case 'w':
      return { x: room.x, y: room.y + offset };
    case 'e':
      return { x: room.x + room.w, y: room.y + offset };
  }
}

/**
 * The stretches of every room wall, split by what is on the other side.
 * Two rooms are neighbours when their interior rectangles touch exactly, which
 * is the invariant every mutation in plan.ts preserves.
 */
export function wallSegments(plan: Plan): WallSegment[] {
  const out: WallSegment[] = [];
  for (const room of plan.rooms) {
    for (const side of SIDES) {
      const len = wallLength(room, side);
      /** Spans along this wall that are covered by a neighbouring room. */
      const covered: { start: number; end: number; id: string }[] = [];
      for (const other of plan.rooms) {
        if (other.id === room.id) continue;
        const touching =
          (side === 'n' && other.y + other.h === room.y) ||
          (side === 's' && other.y === room.y + room.h) ||
          (side === 'w' && other.x + other.w === room.x) ||
          (side === 'e' && other.x === room.x + room.w);
        if (!touching) continue;
        const [aStart, aEnd] =
          side === 'n' || side === 's'
            ? [room.x, room.x + room.w]
            : [room.y, room.y + room.h];
        const [bStart, bEnd] =
          side === 'n' || side === 's'
            ? [other.x, other.x + other.w]
            : [other.y, other.y + other.h];
        const s = Math.max(aStart, bStart);
        const e = Math.min(aEnd, bEnd);
        if (e - s <= 0) continue;
        covered.push({ start: s - aStart, end: e - aStart, id: other.id });
      }
      covered.sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const c of covered) {
        if (c.start > cursor) {
          out.push({ roomId: room.id, side, neighbourId: null, start: cursor, end: c.start });
        }
        out.push({ roomId: room.id, side, neighbourId: c.id, start: c.start, end: c.end });
        cursor = Math.max(cursor, c.end);
      }
      if (cursor < len) {
        out.push({ roomId: room.id, side, neighbourId: null, start: cursor, end: len });
      }
    }
  }
  return out;
}

/** Which room (if any) sits on the far side of an opening. */
export function openingNeighbour(plan: Plan, opening: Opening): string | null {
  const room = plan.rooms.find((r) => r.id === opening.roomId);
  if (!room) return null;
  const mid = opening.offset + opening.width / 2;
  for (const seg of wallSegments(plan)) {
    if (seg.roomId !== room.id || seg.side !== opening.side) continue;
    if (mid >= seg.start && mid <= seg.end) return seg.neighbourId;
  }
  return null;
}

export function isExterior(plan: Plan, opening: Opening): boolean {
  return openingNeighbour(plan, opening) === null;
}

/** Wall thickness at an opening: thin between rooms, thick on the envelope. */
export function wallThicknessAt(plan: Plan, opening: Opening): number {
  return isExterior(plan, opening)
    ? plan.settings.exteriorWall
    : plan.settings.interiorWall;
}

/** The hole itself, as a world rectangle spanning the wall's thickness. */
export function openingRect(plan: Plan, opening: Opening): Rect | null {
  const room = plan.rooms.find((r) => r.id === opening.roomId);
  if (!room) return null;
  const t = wallThicknessAt(plan, opening);
  const a = wallPoint(room, opening.side, opening.offset);
  const horizontal = opening.side === 'n' || opening.side === 's';
  return horizontal
    ? { x: a.x, y: a.y - t / 2, w: opening.width, h: t }
    : { x: a.x - t / 2, y: a.y, w: t, h: opening.width };
}

/**
 * The quarter-disc a hinged door leaf sweeps, approximated by its bounding
 * square. Doors that clash with furniture are one of the most common — and most
 * expensive — mistakes in an amateur plan, so the rule engine checks it.
 */
export function doorSwingRect(plan: Plan, opening: Opening): Rect | null {
  if (opening.kind !== 'door' || opening.swing === 'none') return null;
  const rect = openingRect(plan, opening);
  if (!rect) return null;
  const r = opening.width;
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const n = SIDE_NORMAL[opening.swing as Side];
  // The leaf sweeps a quarter disc of radius `width`; we use its bounding square,
  // anchored on the door centre and extending in the swing direction.
  return {
    x: n.x === 0 ? c.x - r / 2 : n.x > 0 ? c.x : c.x - r,
    y: n.y === 0 ? c.y - r / 2 : n.y > 0 ? c.y : c.y - r,
    w: r,
    h: r,
  };
}

/** Unit vector the item faces. rot 0 faces south, and rotation is clockwise. */
export function facing(f: Furniture): { x: number; y: number } {
  const table = [
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    { x: 1, y: 0 },
  ];
  return table[(f.rot / 90) % 4]!;
}

/** Footprint after rotation, world mm. */
export function furnitureRect(f: Furniture): Rect {
  const swapped = f.rot === 90 || f.rot === 270;
  const w = swapped ? f.h : f.w;
  const h = swapped ? f.w : f.h;
  return { x: f.cx - w / 2, y: f.cy - h / 2, w, h };
}

/** The clear floor an occupant needs in front of the item, or null. */
export function approachRect(f: Furniture): Rect | null {
  if (!f.approach) return null;
  const r = furnitureRect(f);
  const dir = facing(f);
  if (dir.y === 1) return { x: r.x, y: r.y + r.h, w: r.w, h: f.approach };
  if (dir.y === -1) return { x: r.x, y: r.y - f.approach, w: r.w, h: f.approach };
  if (dir.x === 1) return { x: r.x + r.w, y: r.y, w: f.approach, h: r.h };
  return { x: r.x - f.approach, y: r.y, w: f.approach, h: r.h };
}

export function roomContaining(plan: Plan, x: number, y: number): Room | null {
  for (const r of plan.rooms) if (pointInRect(x, y, roomRect(r))) return r;
  return null;
}

/** The room a piece of furniture mostly sits in, by footprint overlap. */
export function furnitureRoom(plan: Plan, f: Furniture): Room | null {
  const fr = furnitureRect(f);
  let best: Room | null = null;
  let bestArea = 0;
  for (const room of plan.rooms) {
    const ov = overlapRect(fr, roomRect(room));
    if (ov && rectArea(ov) > bestArea) {
      bestArea = rectArea(ov);
      best = room;
    }
  }
  return best;
}

/** Floor area in square metres, rounded to 2dp. */
export function areaM2(r: Rect): number {
  return Math.round((r.w * r.h) / 1000) / 1000;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Rounds to the nearest 10 mm — the finest granularity anyone builds to. */
export function snapMm(v: number): number {
  return Math.round(v / 10) * 10;
}

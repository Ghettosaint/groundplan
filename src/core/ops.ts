/**
 * Plan operations.
 *
 * These are the only functions that mutate a Plan, and both the mouse and the
 * WebMCP tools go through them. Each returns a discriminated result rather than
 * throwing, because a tool result that explains *why* an edit was rejected is
 * worth far more to an agent than a stack trace.
 */

import { CATALOG, CATALOG_BY_TYPE, ROOM_TYPES } from './catalog';
import {
  OPPOSITE,
  SIDES,
  approachRect,
  clamp,
  doorSwingRect,
  furnitureRect,
  openingRect,
  overlapRect,
  rectArea,
  rectsOverlap,
  roomRect,
  snapMm,
  wallLength,
  wallSegments,
} from './geometry';
import { uid } from './store';
import type {
  Furniture,
  Opening,
  OpeningKind,
  Plan,
  Rect,
  Room,
  RoomType,
  Side,
} from './types';

export type OpResult<T = unknown> =
  | { ok: true; value: T; message: string }
  | { ok: false; error: string; hint?: string };

const fail = (error: string, hint?: string): OpResult<never> => ({ ok: false, error, hint });
const done = <T>(value: T, message: string): OpResult<T> => ({ ok: true, value, message });

// ── Lookup ───────────────────────────────────────────────────────────────────

/** Resolves a room by id, exact name, or case-insensitive partial name. */
export function findRoom(plan: Plan, ref: string): Room | null {
  if (!ref) return null;
  const needle = ref.trim().toLowerCase();
  return (
    plan.rooms.find((r) => r.id === ref) ??
    plan.rooms.find((r) => r.name.toLowerCase() === needle) ??
    plan.rooms.find((r) => r.name.toLowerCase().includes(needle)) ??
    plan.rooms.find((r) => r.type === needle) ??
    null
  );
}

export function findFurniture(plan: Plan, ref: string): Furniture | null {
  if (!ref) return null;
  const needle = ref.trim().toLowerCase();
  return (
    plan.furniture.find((f) => f.id === ref) ??
    plan.furniture.find((f) => f.label.toLowerCase() === needle) ??
    plan.furniture.find((f) => f.type === needle) ??
    // Substring matching only once there is enough to match on. Two letters
    // will hit something eventually — "ob" is inside "Oven / hob" — and a
    // near-miss that silently resolves is worse than no match at all.
    (needle.length >= 3 ? plan.furniture.find((f) => f.label.toLowerCase().includes(needle)) : undefined) ??
    null
  );
}

export type Entity =
  | { kind: 'room'; id: string; label: string; room: Room }
  | { kind: 'furniture'; id: string; label: string; item: Furniture }
  | { kind: 'opening'; id: string; label: string; opening: Opening };

/**
 * Resolves a reference to whatever it names, whichever kind that is.
 *
 * Ids win outright, across all three kinds, before any name matching is tried.
 * Resolving by kind in turn used to mean a fuzzy furniture match could swallow
 * an exact opening id.
 */
export function findEntity(plan: Plan, ref: string): Entity | null {
  if (!ref) return null;
  const room = plan.rooms.find((r) => r.id === ref);
  if (room) return { kind: 'room', id: room.id, label: room.name, room };
  const item = plan.furniture.find((f) => f.id === ref);
  if (item) return { kind: 'furniture', id: item.id, label: item.label, item };
  const opening = plan.openings.find((o) => o.id === ref);
  if (opening) return { kind: 'opening', id: opening.id, label: opening.kind, opening };

  const byName = findRoom(plan, ref);
  if (byName) return { kind: 'room', id: byName.id, label: byName.name, room: byName };
  const byLabel = findFurniture(plan, ref);
  if (byLabel) return { kind: 'furniture', id: byLabel.id, label: byLabel.label, item: byLabel };
  return null;
}

export function findOpening(plan: Plan, ref: string): Opening | null {
  if (!ref) return null;
  return plan.openings.find((o) => o.id === ref) ?? null;
}

export function roomNames(plan: Plan): string {
  return plan.rooms.map((r) => `"${r.name}"`).join(', ') || '(none)';
}

// ── Rooms ────────────────────────────────────────────────────────────────────

export interface AddRoomInput {
  name?: string;
  type: RoomType;
  widthMm: number;
  depthMm: number;
  /** Absolute placement. */
  xMm?: number;
  yMm?: number;
  /** Or: attach flush against an existing room's wall. */
  againstRoom?: string;
  againstSide?: Side;
  /** Offset along that wall from its start, mm. */
  alignMm?: number;
}

export function addRoom(plan: Plan, input: AddRoomInput): OpResult<Room> {
  const meta = ROOM_TYPES[input.type];
  if (!meta) return fail(`Unknown room type "${input.type}".`, `Use one of: ${Object.keys(ROOM_TYPES).join(', ')}.`);
  const w = snapMm(input.widthMm);
  const h = snapMm(input.depthMm);
  if (w < 600 || h < 600) return fail('Rooms must be at least 600 mm in each direction.');

  let x: number;
  let y: number;

  if (input.againstRoom) {
    const anchor = findRoom(plan, input.againstRoom);
    if (!anchor) return fail(`No room called "${input.againstRoom}".`, `Rooms in this plan: ${roomNames(plan)}.`);
    const side = input.againstSide ?? 'e';
    const align = snapMm(input.alignMm ?? 0);
    switch (side) {
      case 'n':
        x = anchor.x + align;
        y = anchor.y - h;
        break;
      case 's':
        x = anchor.x + align;
        y = anchor.y + anchor.h;
        break;
      case 'w':
        x = anchor.x - w;
        y = anchor.y + align;
        break;
      case 'e':
        x = anchor.x + anchor.w;
        y = anchor.y + align;
        break;
    }
  } else if (input.xMm !== undefined && input.yMm !== undefined) {
    x = snapMm(input.xMm);
    y = snapMm(input.yMm);
  } else if (plan.rooms.length === 0) {
    x = 0;
    y = 0;
  } else {
    // Park it clear of everything to the east, so nothing silently overlaps.
    const right = Math.max(...plan.rooms.map((r) => r.x + r.w));
    x = right;
    y = Math.min(...plan.rooms.map((r) => r.y));
  }

  const rect: Rect = { x, y, w, h };
  const clash = plan.rooms.find((r) => overlapRect(rect, roomRect(r)));
  if (clash) {
    return fail(
      `That rectangle overlaps "${clash.name}".`,
      'Rooms have to meet edge to edge. Try `against_room` with a side, or shift the position.',
    );
  }

  const name = input.name?.trim() || uniqueName(plan, meta.label);
  const created: Room = { id: uid('r'), name, type: input.type, x, y, w, h };
  plan.rooms.push(created);
  return done(created, `Added "${name}" — ${w} × ${h} mm (${((w * h) / 1e6).toFixed(2)} m²) at (${x}, ${y}).`);
}

function uniqueName(plan: Plan, base: string): string {
  if (!plan.rooms.some((r) => r.name === base)) return base;
  let i = 2;
  while (plan.rooms.some((r) => r.name === `${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function resizeRoom(
  plan: Plan,
  ref: string,
  widthMm?: number,
  depthMm?: number,
  anchor: Side | 'centre' = 'centre',
): OpResult<Room> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  const w = widthMm === undefined ? room.w : snapMm(widthMm);
  const h = depthMm === undefined ? room.h : snapMm(depthMm);
  if (w < 600 || h < 600) return fail('Rooms must be at least 600 mm in each direction.');

  let x = room.x;
  let y = room.y;
  if (anchor === 'centre') {
    x = snapMm(room.x + (room.w - w) / 2);
    y = snapMm(room.y + (room.h - h) / 2);
  } else if (anchor === 'e') {
    x = room.x + room.w - w;
  } else if (anchor === 's') {
    y = room.y + room.h - h;
  }

  const rect: Rect = { x, y, w, h };
  const clash = plan.rooms.find((r) => r.id !== room.id && overlapRect(rect, roomRect(r)));
  if (clash) return fail(`Resizing "${room.name}" would push it into "${clash.name}".`, 'Move the neighbour first, or anchor the resize to the opposite wall.');

  const before = `${room.w} × ${room.h}`;
  room.x = x;
  room.y = y;
  room.w = w;
  room.h = h;
  clampOpenings(plan, room);
  return done(room, `Resized "${room.name}" from ${before} to ${w} × ${h} mm.`);
}

export function moveRoom(plan: Plan, ref: string, dxMm: number, dyMm: number): OpResult<Room> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  const rect: Rect = { x: room.x + snapMm(dxMm), y: room.y + snapMm(dyMm), w: room.w, h: room.h };
  const clash = plan.rooms.find((r) => r.id !== room.id && overlapRect(rect, roomRect(r)));
  if (clash) return fail(`Moving "${room.name}" there would overlap "${clash.name}".`);
  const dx = rect.x - room.x;
  const dy = rect.y - room.y;
  room.x = rect.x;
  room.y = rect.y;
  for (const f of plan.furniture) {
    // Carry the contents along with the room.
    if (pointInside(f.cx - dx, f.cy - dy, room, dx, dy)) {
      f.cx += dx;
      f.cy += dy;
    }
  }
  return done(room, `Moved "${room.name}" by ${dx} × ${dy} mm to (${room.x}, ${room.y}).`);
}

function pointInside(px: number, py: number, room: Room, dx: number, dy: number): boolean {
  const r = { x: room.x - dx, y: room.y - dy, w: room.w, h: room.h };
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function deleteRoom(plan: Plan, ref: string): OpResult<{ id: string; name: string }> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  const droppedOpenings = plan.openings.filter((o) => o.roomId === room.id).length;
  const inside = plan.furniture.filter((f) => rectsOverlap(furnitureRect(f), roomRect(room)));
  plan.rooms = plan.rooms.filter((r) => r.id !== room.id);
  plan.openings = plan.openings.filter((o) => o.roomId !== room.id);
  plan.furniture = plan.furniture.filter((f) => !inside.includes(f));
  return done(
    { id: room.id, name: room.name },
    `Deleted "${room.name}", along with ${droppedOpenings} opening(s) and ${inside.length} item(s) of furniture.`,
  );
}

export function renameRoom(plan: Plan, ref: string, name: string): OpResult<Room> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  const old = room.name;
  room.name = name.trim() || old;
  return done(room, `Renamed "${old}" to "${room.name}".`);
}

export function setRoomType(plan: Plan, ref: string, type: RoomType): OpResult<Room> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  if (!ROOM_TYPES[type]) return fail(`Unknown room type "${type}".`, `Use one of: ${Object.keys(ROOM_TYPES).join(', ')}.`);
  room.type = type;
  return done(room, `"${room.name}" is now a ${ROOM_TYPES[type].label.toLowerCase()}.`);
}

/** Keeps openings inside their wall after the room changes shape. */
function clampOpenings(plan: Plan, room: Room): void {
  for (const op of plan.openings) {
    if (op.roomId !== room.id) continue;
    const len = wallLength(room, op.side);
    op.width = Math.min(op.width, Math.max(600, len - 200));
    op.offset = clamp(op.offset, 100, Math.max(100, len - op.width - 100));
  }
}

// ── Openings ─────────────────────────────────────────────────────────────────

export interface AddOpeningInput {
  roomRef: string;
  side: Side;
  kind: OpeningKind;
  widthMm?: number;
  /** Offset along the wall, mm from its start. Omit to centre on the best free run. */
  offsetMm?: number;
  swing?: Side | 'none';
  sillMm?: number;
  headMm?: number;
  /** For doors: name of the room this should open into, instead of a side. */
  toRoom?: string;
  /** Force an external opening (front door, window) rather than an internal one. */
  exterior?: boolean;
}

export function addOpening(plan: Plan, input: AddOpeningInput): OpResult<Opening> {
  const room = findRoom(plan, input.roomRef);
  if (!room) return fail(`No room called "${input.roomRef}".`, `Rooms in this plan: ${roomNames(plan)}.`);

  let side = input.side;
  if (input.toRoom) {
    const target = findRoom(plan, input.toRoom);
    if (!target) return fail(`No room called "${input.toRoom}".`, `Rooms in this plan: ${roomNames(plan)}.`);
    const seg = wallSegments(plan).find((s) => s.roomId === room.id && s.neighbourId === target.id);
    if (!seg) {
      return fail(
        `"${room.name}" and "${target.name}" do not share a wall.`,
        'Only rooms whose rectangles touch can be connected directly. Route through a hall, or move one of them.',
      );
    }
    side = seg.side;
  }

  const width = snapMm(input.widthMm ?? (input.kind === 'window' ? 1200 : 900));
  const len = wallLength(room, side);
  if (width + 200 > len) {
    return fail(
      `A ${width} mm opening will not fit the ${len} mm ${sideWord(side)} wall of "${room.name}".`,
      `The widest that fits with jambs is ${Math.max(0, len - 200)} mm.`,
    );
  }

  const segs = wallSegments(plan).filter((s) => s.roomId === room.id && s.side === side);
  const wantsNeighbour = input.kind !== 'window';
  const candidates = segs.filter((s) =>
    input.toRoom ? s.neighbourId === findRoom(plan, input.toRoom)?.id : true,
  );
  const usable = candidates.filter((s) => s.end - s.start >= width + 100);
  if (usable.length === 0) {
    return fail(
      `No clear run of ${width} mm on the ${sideWord(side)} wall of "${room.name}".`,
      `The longest available stretch is ${Math.max(0, ...candidates.map((s) => s.end - s.start))} mm.`,
    );
  }

  // Windows want an outside face; doors usually want a neighbour, but an
  // external door is perfectly legitimate, so we only prefer, never require.
  const wantsExterior = input.exterior === true || input.kind === 'window';
  const preferred = usable.filter((s) =>
    wantsExterior ? s.neighbourId === null : wantsNeighbour ? s.neighbourId !== null : true,
  );
  if (preferred.length === 0 && wantsExterior) {
    return fail(
      `The ${sideWord(side)} wall of "${room.name}" backs onto another room, so nothing there can face outdoors.`,
      'Pick a side that faces outside, or drop the exterior requirement.',
    );
  }
  const pool = preferred.length > 0 ? preferred : usable;
  const seg = pool.sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;

  let offset =
    input.offsetMm !== undefined
      ? snapMm(input.offsetMm)
      : snapMm(seg.start + (seg.end - seg.start - width) / 2);
  offset = clamp(offset, seg.start + 50, seg.end - width - 50);

  const overlapping = plan.openings.find(
    (o) => o.roomId === room.id && o.side === side && offset < o.offset + o.width + 50 && o.offset < offset + width + 50,
  );
  if (overlapping) {
    return fail(
      `That would collide with an existing ${overlapping.kind} on the same wall.`,
      `The existing one runs from ${overlapping.offset} to ${overlapping.offset + overlapping.width} mm.`,
    );
  }

  const swing: Side | 'none' =
    input.kind !== 'door' ? 'none' : (input.swing ?? OPPOSITE[side]);

  const created: Opening = {
    id: uid('o'),
    kind: input.kind,
    roomId: room.id,
    side,
    offset,
    width,
    swing,
    ...(input.kind === 'window'
      ? { sill: input.sillMm ?? 900, head: input.headMm ?? 2100 }
      : {}),
  };
  plan.openings.push(created);
  const neighbourName = seg.neighbourId ? plan.rooms.find((r) => r.id === seg.neighbourId)?.name : 'outside';
  return done(
    created,
    `Added a ${width} mm ${input.kind} on the ${sideWord(side)} wall of "${room.name}", opening to ${neighbourName}.`,
  );
}

export function setOpeningWidth(plan: Plan, ref: string, widthMm: number): OpResult<Opening> {
  const op = findOpening(plan, ref);
  if (!op) return fail(`No opening with id "${ref}".`, 'Call get_plan to list opening ids.');
  const room = plan.rooms.find((r) => r.id === op.roomId);
  if (!room) return fail('That opening has lost its room.');
  const width = snapMm(widthMm);
  const len = wallLength(room, op.side);
  if (op.offset + width + 50 > len) {
    const shifted = clamp(len - width - 50, 50, len);
    if (shifted < 50) return fail(`A ${width} mm opening will not fit that ${len} mm wall.`);
    op.offset = snapMm(shifted);
  }
  const before = op.width;
  op.width = width;
  if (width >= 1400 && op.kind === 'door') {
    op.kind = 'archway';
    op.swing = 'none';
  }
  return done(op, `Widened the opening from ${before} mm to ${width} mm.`);
}

export function moveOpening(plan: Plan, ref: string, offsetMm: number): OpResult<Opening> {
  const op = findOpening(plan, ref);
  if (!op) return fail(`No opening with id "${ref}".`);
  const room = plan.rooms.find((r) => r.id === op.roomId);
  if (!room) return fail('That opening has lost its room.');
  const len = wallLength(room, op.side);
  const before = op.offset;
  op.offset = clamp(snapMm(offsetMm), 50, Math.max(50, len - op.width - 50));
  return done(op, `Slid the opening along its wall from ${before} mm to ${op.offset} mm.`);
}

export function setDoorSwing(plan: Plan, ref: string, swing: Side | 'none'): OpResult<Opening> {
  const op = findOpening(plan, ref);
  if (!op) return fail(`No opening with id "${ref}".`);
  if (op.kind === 'window') return fail('Windows do not swing.');
  op.swing = swing;
  return done(op, swing === 'none' ? 'Door is now sliding — no swing.' : `Door now swings ${swing}.`);
}

export function deleteOpening(plan: Plan, ref: string): OpResult<{ id: string }> {
  const op = findOpening(plan, ref);
  if (!op) return fail(`No opening with id "${ref}".`);
  plan.openings = plan.openings.filter((o) => o.id !== op.id);
  return done({ id: op.id }, `Removed the ${op.kind}.`);
}

function sideWord(s: Side): string {
  return { n: 'north', e: 'east', s: 'south', w: 'west' }[s];
}

// ── Furniture ────────────────────────────────────────────────────────────────

export interface AddFurnitureInput {
  type: string;
  roomRef: string;
  xMm?: number;
  yMm?: number;
  /** Park it against this wall of the room and find a free run automatically. */
  againstSide?: Side;
  rot?: 0 | 90 | 180 | 270;
  label?: string;
}

export function addFurniture(plan: Plan, input: AddFurnitureInput): OpResult<Furniture> {
  const item = CATALOG_BY_TYPE.get(input.type);
  if (!item) {
    return fail(
      `Unknown furniture type "${input.type}".`,
      `Call list_catalog for the full list. Closest matches: ${suggest(input.type).join(', ')}.`,
    );
  }
  const room = findRoom(plan, input.roomRef);
  if (!room) return fail(`No room called "${input.roomRef}".`, `Rooms in this plan: ${roomNames(plan)}.`);

  const draft: Furniture = {
    id: uid('f'),
    type: item.type,
    label: input.label ?? item.label,
    category: item.category,
    cx: 0,
    cy: 0,
    w: item.w,
    h: item.h,
    rot: input.rot ?? 0,
    approach: item.approach,
  };

  if (input.xMm !== undefined && input.yMm !== undefined) {
    draft.cx = snapMm(input.xMm);
    draft.cy = snapMm(input.yMm);
  } else {
    const spot = findSpot(plan, room, draft, input.againstSide);
    if (!spot) {
      return fail(
        `No free floor left in "${room.name}" for a ${item.label.toLowerCase()}.`,
        'Move or remove something first, or place it explicitly with x_mm / y_mm.',
      );
    }
    draft.cx = spot.cx;
    draft.cy = spot.cy;
    draft.rot = spot.rot;
  }

  plan.furniture.push(draft);
  return done(
    draft,
    `Placed ${draft.label.toLowerCase()} in "${room.name}" at (${draft.cx}, ${draft.cy}), rotated ${draft.rot}°.`,
  );
}

function suggest(query: string): string[] {
  const q = query.toLowerCase();
  return CATALOG.map((c) => c.type)
    .filter((t) => t.includes(q.slice(0, 3)) || q.includes(t.slice(0, 3)))
    .slice(0, 4);
}

/**
 * Wall placement that respects the things the rule engine will check.
 *
 * The naive version — walk each wall, take the first gap — cheerfully parked a
 * wardrobe across a doorway and a fridge facing a worktop, so `furnish_room`
 * produced rooms that failed inspection the moment they were furnished. This
 * one rules out anything the checker would object to, then picks the候 position
 * that leaves the most space around it.
 *
 * If nothing satisfies the full set, it relaxes the clear-floor requirement and
 * tries again: a bookshelf somewhere imperfect is more useful than no bookshelf
 * and an error message.
 */
function findSpot(
  plan: Plan,
  room: Room,
  item: Furniture,
  preferSide?: Side,
): { cx: number; cy: number; rot: 0 | 90 | 180 | 270 } | null {
  const strict = searchSpot(plan, room, item, preferSide, true);
  return strict ?? searchSpot(plan, room, item, preferSide, false);
}

function searchSpot(
  plan: Plan,
  room: Room,
  item: Furniture,
  preferSide: Side | undefined,
  respectApproach: boolean,
): { cx: number; cy: number; rot: 0 | 90 | 180 | 270 } | null {
  const sides = preferSide ? [preferSide, ...SIDES.filter((x) => x !== preferSide)] : SIDES;
  const others = plan.furniture.filter((f) => rectsOverlap(furnitureRect(f), roomRect(room), 1));
  const step = 100;
  const shell = roomRect(room);

  // Doorways that open into this room, plus the arcs their leaves sweep. Both
  // have to stay clear or the room fails the moment it is furnished.
  const keepClear: Rect[] = [];
  for (const op of plan.openings) {
    const hole = openingRect(plan, op);
    if (hole && rectsOverlap(hole, shell, 1) && op.kind !== 'window') {
      keepClear.push(padAlongWall(hole, op.side, 150));
    }
    const swing = doorSwingRect(plan, op);
    if (swing && rectsOverlap(swing, shell, 1)) keepClear.push(swing);
  }

  let best: { cx: number; cy: number; rot: 0 | 90 | 180 | 270; score: number } | null = null;

  for (const [rank, side] of sides.entries()) {
    // Facing into the room from this wall: rot 0 faces south, clockwise from there.
    const rot: 0 | 90 | 180 | 270 =
      side === 'n' ? 0 : side === 'e' ? 90 : side === 's' ? 180 : 270;
    const probe: Furniture = { ...item, rot };
    const box = furnitureRect({ ...probe, cx: 0, cy: 0 });
    if (box.w > room.w || box.h > room.h) continue;

    const along = side === 'n' || side === 's' ? room.w - box.w : room.h - box.h;
    for (let t = 0; t <= along; t += step) {
      const cx =
        side === 'n' || side === 's'
          ? room.x + t + box.w / 2
          : side === 'w'
            ? room.x + box.w / 2
            : room.x + room.w - box.w / 2;
      const cy =
        side === 'w' || side === 'e'
          ? room.y + t + box.h / 2
          : side === 'n'
            ? room.y + box.h / 2
            : room.y + room.h - box.h / 2;

      const candidate: Furniture = { ...probe, cx, cy };
      const rect = furnitureRect(candidate);

      if (others.some((o) => rectsOverlap(rect, furnitureRect(o), 1))) continue;
      if (keepClear.some((r) => rectsOverlap(rect, r, 1))) continue;
      // Do not stand in the clear floor another fitting needs.
      if (others.some((o) => zoneBlockedBy(o, rect))) continue;

      const zone = approachRect(candidate);
      if (respectApproach && zone) {
        if (!containsRect(shell, zone)) continue;
        if (others.some((o) => blocksZone(zone, o))) continue;
      }

      const clearance = others.length
        ? Math.min(...others.map((o) => gapBetween(rect, furnitureRect(o))))
        : Number.MAX_SAFE_INTEGER;
      const score = Math.min(clearance, 4000) - rank * 40;
      if (!best || score > best.score) best = { cx: snapMm(cx), cy: snapMm(cy), rot, score };
    }
  }

  return best ? { cx: best.cx, cy: best.cy, rot: best.rot } : null;
}

/** Widens a doorway rectangle along its wall, so nothing lands on the jamb. */
function padAlongWall(r: Rect, side: Side, amount: number): Rect {
  return side === 'n' || side === 's'
    ? { x: r.x - amount, y: r.y, w: r.w + amount * 2, h: r.h }
    : { x: r.x, y: r.y - amount, w: r.w, h: r.h + amount * 2 };
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 &&
    inner.y + inner.h <= outer.y + outer.h + 1
  );
}

/** True when `intruder` takes enough of `zone` to count as being in the way. */
function blocksZone(zone: Rect, other: Furniture): boolean {
  if (CATALOG_BY_TYPE.get(other.type)?.blocksApproach === false) return false;
  const ov = overlapRect(zone, furnitureRect(other));
  return ov !== null && rectArea(ov) / rectArea(zone) > 0.2;
}

/** True when a new footprint would stand in the clear floor `owner` needs. */
function zoneBlockedBy(owner: Furniture, incoming: Rect): boolean {
  if (CATALOG_BY_TYPE.get(owner.type)?.blocksApproach === false) return false;
  const zone = approachRect(owner);
  if (!zone) return false;
  const ov = overlapRect(zone, incoming);
  return ov !== null && rectArea(ov) / rectArea(zone) > 0.2;
}

/** Shortest gap between two rectangles, 0 when they touch or overlap. */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)));
  const dy = Math.max(0, Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)));
  return Math.hypot(dx, dy);
}

export function moveFurniture(plan: Plan, ref: string, xMm: number, yMm: number): OpResult<Furniture> {
  const f = findFurniture(plan, ref);
  if (!f) return fail(`No furniture called "${ref}".`, 'Call get_plan to list what is placed.');
  const before = `(${f.cx}, ${f.cy})`;
  f.cx = snapMm(xMm);
  f.cy = snapMm(yMm);
  return done(f, `Moved ${f.label.toLowerCase()} from ${before} to (${f.cx}, ${f.cy}).`);
}

export function nudgeFurniture(plan: Plan, ref: string, dx: number, dy: number): OpResult<Furniture> {
  const f = findFurniture(plan, ref);
  if (!f) return fail(`No furniture called "${ref}".`);
  return moveFurniture(plan, f.id, f.cx + dx, f.cy + dy);
}

export function rotateFurniture(plan: Plan, ref: string, rot: 0 | 90 | 180 | 270): OpResult<Furniture> {
  const f = findFurniture(plan, ref);
  if (!f) return fail(`No furniture called "${ref}".`);
  if (![0, 90, 180, 270].includes(rot)) return fail('Rotation must be 0, 90, 180 or 270 degrees.');
  f.rot = rot;
  return done(f, `Rotated ${f.label.toLowerCase()} to ${rot}°.`);
}

export function deleteFurniture(plan: Plan, ref: string): OpResult<{ id: string; label: string }> {
  const f = findFurniture(plan, ref);
  if (!f) return fail(`No furniture called "${ref}".`);
  plan.furniture = plan.furniture.filter((x) => x.id !== f.id);
  return done({ id: f.id, label: f.label }, `Removed ${f.label.toLowerCase()}.`);
}

export function clearRoom(plan: Plan, ref: string): OpResult<{ removed: number }> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);
  const before = plan.furniture.length;
  plan.furniture = plan.furniture.filter((f) => !rectsOverlap(furnitureRect(f), roomRect(room), 1));
  const removed = before - plan.furniture.length;
  return done({ removed }, `Cleared ${removed} item(s) out of "${room.name}".`);
}

/**
 * Fills a room with a sensible kit for its type, backing everything against the
 * walls so the middle stays open. Used by the `furnish_room` tool.
 */
export function furnishRoom(plan: Plan, ref: string, extra: string[] = []): OpResult<{ placed: string[]; skipped: string[] }> {
  const room = findRoom(plan, ref);
  if (!room) return fail(`No room called "${ref}".`, `Rooms in this plan: ${roomNames(plan)}.`);

  const programme: Record<RoomType, string[]> = {
    living: ['sofa_3', 'coffee_table', 'armchair', 'bookshelf'],
    bedroom: ['bed_double', 'wardrobe', 'bedside'],
    kitchen: ['counter_run', 'fridge', 'oven', 'sink_kitchen'],
    bathroom: ['wc', 'basin', 'shower'],
    dining: ['dining_table_6', 'sideboard'],
    office: ['desk', 'bookshelf', 'armchair'],
    utility: ['washer', 'counter_run'],
    hall: ['shoe_rack'],
    storage: [],
    balcony: [],
  };

  const wanted = [...(programme[room.type] ?? []), ...extra];
  const placed: string[] = [];
  const skipped: string[] = [];
  for (const type of wanted) {
    const res = addFurniture(plan, { type, roomRef: room.id });
    if (res.ok) placed.push(res.value.label);
    else skipped.push(`${type} (${res.error})`);
  }
  if (placed.length === 0) {
    return fail(
      `Nothing would fit in "${room.name}".`,
      skipped.length ? `Tried: ${skipped.join('; ')}` : undefined,
    );
  }
  return done(
    { placed, skipped },
    `Furnished "${room.name}" with ${placed.join(', ')}.${skipped.length ? ` Skipped ${skipped.length} item(s) for lack of space.` : ''}`,
  );
}

export function setSettings(plan: Plan, patch: Partial<Plan['settings']>): OpResult<Plan['settings']> {
  const next = { ...plan.settings, ...patch };
  if (next.mobilityRadius < 200 || next.mobilityRadius > 900) {
    return fail('mobility_radius_mm must be between 200 and 900.');
  }
  plan.settings = next;
  return done(next, `Standards updated: ${next.mobilityRadius * 2} mm circulation, ${next.turningCircle} mm turning circle, ${next.minClearDoor} mm clear doors.`);
}

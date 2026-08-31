/**
 * Canonical repairs.
 *
 * `check_plan` tells an agent what is wrong and hands it a `fix` sentence; this
 * module is the shortcut that performs the obvious repair directly. It is the
 * difference between an agent that narrates problems and one that closes them.
 *
 * Every fix works on a draft plan and reports what it did, so the result can be
 * shown to the user for approval before anything lands.
 */

import { OPPOSITE, furnitureRect, rectsOverlap, roomRect, wallSegments } from './geometry';
import { maxClearanceIn, rasterise, reachableFrom, roomReachRatio, widestPaths } from './grid';
import { findBottleneck } from './rules';
import {
  addFurniture,
  addOpening,
  deleteFurniture,
  findRoom,
  setDoorSwing,
  setOpeningWidth,
} from './ops';
import type { Plan, Room, Side, Violation } from './types';

export interface FixOutcome {
  applied: boolean;
  actions: string[];
  reason?: string;
}

const ok = (actions: string[]): FixOutcome => ({ applied: true, actions });
const no = (reason: string): FixOutcome => ({ applied: false, actions: [], reason });

/** Applies the standard repair for one violation, in place, on a draft plan. */
export function applyFix(plan: Plan, violation: Violation): FixOutcome {
  switch (violation.rule) {
    case 'door.clear_width':
      return widenDoor(plan, violation.entities[0]!, plan.settings.minClearDoor + 85);

    case 'access.unreachable':
      return openRouteTo(plan, violation.entities[0]!);

    case 'plan.no_entry':
      return addEntryDoor(plan);

    case 'room.no_door':
      return connectRoom(plan, violation.entities[0]!);

    case 'room.daylight':
    case 'bedroom.egress':
      return addDaylight(plan, violation.entities[0]!);

    case 'access.turning_circle':
    case 'access.partial':
      return openUpRoom(plan, violation.entities[0]!);

    case 'door.swing_clash':
      return flipSwing(plan, violation.entities[0]!);

    case 'furniture.overlap':
    case 'furniture.outside':
    case 'furniture.approach':
      return rehomeFurniture(plan, violation.entities[0]!);

    case 'room.min_area':
    case 'room.min_dimension':
      return no(
        'Growing a room means taking space from a neighbour, which is a judgement call rather than a repair. Use edit_room deliberately instead.',
      );

    default:
      return no(`No automatic repair is defined for "${violation.rule}".`);
  }
}

function widenDoor(plan: Plan, openingId: string, target: number): FixOutcome {
  const res = setOpeningWidth(plan, openingId, target);
  return res.ok ? ok([res.message]) : no(res.error);
}

/**
 * Opens the route to a stranded room by widening whatever is actually pinching
 * it — not every door in the flat. Each pass re-measures, so a plan with two
 * bottlenecks in series gets both, and the loop stops the moment the room
 * connects.
 */
function openRouteTo(plan: Plan, roomId: string): FixOutcome {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return no('That room is gone.');
  const target = Math.max(plan.settings.minClearDoor + 85, plan.settings.mobilityRadius * 2 + 100);
  const actions: string[] = [];

  for (let pass = 0; pass < 4; pass++) {
    const grid = rasterise(plan);
    const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
    if (roomReachRatio(grid, reach, room) >= 0.05) {
      actions.push(`"${room.name}" is now reachable from the entrance.`);
      return ok(actions);
    }
    const neck = findBottleneck(plan, grid, widestPaths(grid, reach.seed), room);
    if (!neck) {
      const connected = connectRoom(plan, roomId);
      return connected.applied ? ok([...actions, ...connected.actions]) : connected;
    }
    if (neck.openingId) {
      const op = plan.openings.find((o) => o.id === neck.openingId);
      if (op && op.width >= target) {
        // The doorway is wide enough on paper; something is standing in it.
        const intruder = blockerNear(plan, neck.at);
        if (!intruder) break;
        const moved = rehomeFurniture(plan, intruder.id);
        if (!moved.applied) break;
        actions.push(...moved.actions);
        continue;
      }
      const res = setOpeningWidth(plan, neck.openingId, target);
      if (!res.ok) break;
      actions.push(`${res.message} (${neck.description}, the tightest point on the route)`);
      continue;
    }
    const intruder = blockerNear(plan, neck.at);
    if (!intruder) break;
    const moved = rehomeFurniture(plan, intruder.id);
    if (!moved.applied) break;
    actions.push(...moved.actions);
  }

  if (actions.length === 0) {
    return no(`Could not find anything on the route to "${room.name}" that would help to widen.`);
  }
  return {
    applied: true,
    actions: [...actions, 'The route is wider, but the room is still not fully connected — check the plan again.'],
    reason: 'Partially fixed.',
  };
}

/** The largest thing sitting within a metre and a half of a pinch point. */
function blockerNear(plan: Plan, at: { x: number; y: number }) {
  return plan.furniture
    .map((f) => ({ f, d: Math.hypot(f.cx - at.x, f.cy - at.y) }))
    .filter((x) => x.d < 1500)
    .sort((a, b) => b.f.w * b.f.h - a.f.w * a.f.h)[0]?.f;
}

function addEntryDoor(plan: Plan): FixOutcome {
  const preference = ['hall', 'living', 'kitchen'];
  const candidates = [...plan.rooms].sort(
    (a, b) => preference.indexOf(a.type) - preference.indexOf(b.type),
  );
  for (const room of candidates) {
    for (const side of externalSides(plan, room)) {
      const res = addOpening(plan, {
        roomRef: room.id,
        side,
        kind: 'door',
        widthMm: Math.max(900, plan.settings.minClearDoor + 85),
        swing: OPPOSITE[side],
        exterior: true,
      });
      if (res.ok) return ok([res.message]);
    }
  }
  return no('Could not find an external wall long enough for a front door.');
}

function connectRoom(plan: Plan, roomId: string): FixOutcome {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return no('That room is gone.');
  const segs = wallSegments(plan)
    .filter((s) => s.roomId === room.id && s.neighbourId !== null)
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const width = Math.max(900, plan.settings.minClearDoor + 85);
  for (const seg of segs) {
    const res = addOpening(plan, {
      roomRef: room.id,
      side: seg.side,
      kind: 'door',
      widthMm: width,
      swing: OPPOSITE[seg.side],
    });
    if (res.ok) return ok([res.message]);
  }
  return no(`"${room.name}" does not share a long enough wall with any neighbour to take a door.`);
}

function addDaylight(plan: Plan, roomId: string): FixOutcome {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return no('That room is gone.');
  const actions: string[] = [];
  for (const side of externalSides(plan, room)) {
    const res = addOpening(plan, { roomRef: room.id, side, kind: 'window', widthMm: 1400, exterior: true });
    if (res.ok) {
      actions.push(res.message);
      break;
    }
  }
  return actions.length ? ok(actions) : no(`"${room.name}" has no external wall with room for a window.`);
}

function externalSides(plan: Plan, room: Room): Side[] {
  const segs = wallSegments(plan).filter((s) => s.roomId === room.id && s.neighbourId === null);
  const byLength = new Map<Side, number>();
  for (const s of segs) byLength.set(s.side, Math.max(byLength.get(s.side) ?? 0, s.end - s.start));
  return [...byLength.entries()].sort((a, b) => b[1] - a[1]).map(([side]) => side);
}

/**
 * Frees up a turning circle by re-parking the furniture that is stealing it —
 * smallest first, so the room keeps as much of its kit as possible.
 */
function openUpRoom(plan: Plan, roomId: string): FixOutcome {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return no('That room is gone.');
  const target = plan.settings.turningCircle;
  const actions: string[] = [];

  const measure = () => maxClearanceIn(rasterise(plan), roomRect(room)).value * 2;
  if (measure() >= target) return ok(['Already clear — nothing to move.']);

  const inRoom = plan.furniture
    .filter((f) => rectsOverlap(furnitureRect(f), roomRect(room), 1))
    .sort((a, b) => a.w * a.h - b.w * b.h);

  for (const item of inRoom) {
    const snapshot = { cx: item.cx, cy: item.cy, rot: item.rot };
    const type = item.type;
    const label = item.label;
    // Lift it out, then let the wall-hugging placer find it a better berth.
    const keepId = item.id;
    deleteFurniture(plan, item.id);
    const replaced = addFurniture(plan, { type, roomRef: room.id, label });
    // Carry the id across so this reads as a move, not a deletion and a purchase.
    if (replaced.ok) replaced.value.id = keepId;
    if (!replaced.ok) {
      // Could not re-place it; leaving it out is still a valid repair to offer.
      actions.push(`Removed ${label.toLowerCase()} — it would not fit anywhere clear of the turning circle.`);
    } else if (
      replaced.value.cx === snapshot.cx &&
      replaced.value.cy === snapshot.cy &&
      replaced.value.rot === snapshot.rot
    ) {
      actions.push(`${label} is already against a wall.`);
    } else {
      actions.push(
        `Moved ${label.toLowerCase()} to (${replaced.value.cx}, ${replaced.value.cy}) against the nearest wall.`,
      );
    }
    if (measure() >= target) break;
  }

  const finalCircle = Math.round(measure());
  if (finalCircle < target) {
    actions.push(
      `Best clear circle after rearranging is ${finalCircle} mm, still short of ${target} mm — the room itself is too small.`,
    );
    return { applied: actions.length > 0, actions, reason: 'Partially fixed: the room needs more floor area.' };
  }
  actions.push(`Clear turning circle is now ${finalCircle} mm.`);
  return ok(actions);
}

function flipSwing(plan: Plan, openingId: string): FixOutcome {
  const op = plan.openings.find((o) => o.id === openingId);
  if (!op || op.swing === 'none') return no('That door does not swing.');
  const res = setDoorSwing(plan, op.id, OPPOSITE[op.swing as Side]);
  return res.ok ? ok([res.message]) : no(res.error);
}

function rehomeFurniture(plan: Plan, furnitureId: string): FixOutcome {
  const item = plan.furniture.find((f) => f.id === furnitureId);
  if (!item) return no('That item is gone.');
  const room =
    plan.rooms.find((r) => rectsOverlap(furnitureRect(item), roomRect(r), 1)) ?? plan.rooms[0];
  if (!room) return no('There is nowhere to put it.');
  const { type, label, id } = item;
  deleteFurniture(plan, item.id);
  const res = addFurniture(plan, { type, roomRef: room.id, label });
  if (!res.ok) return no(`Nowhere clear in "${room.name}" to re-park the ${label.toLowerCase()}.`);
  res.value.id = id;
  return ok([`Re-parked ${label.toLowerCase()} against a wall in "${room.name}".`]);
}

/** Convenience for the tool layer: look a violation up by rule and entity. */
export function findViolation(
  violations: Violation[],
  rule: string,
  entityRef?: string,
  plan?: Plan,
): Violation | undefined {
  const candidates = violations.filter((v) => v.rule === rule);
  if (!entityRef) return candidates[0];
  const room = plan ? findRoom(plan, entityRef) : null;
  return (
    candidates.find((v) => v.entities.includes(entityRef)) ??
    (room ? candidates.find((v) => v.entities.includes(room.id)) : undefined) ??
    candidates[0]
  );
}

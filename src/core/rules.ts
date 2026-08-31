/**
 * The rule engine.
 *
 * Every check produces a `Violation` carrying the measured value, the required
 * value and a `fix` string phrased as an instruction. That shape is deliberate:
 * it is what turns `check_plan` from a status light into something an agent can
 * iterate against, calling a mutation, re-checking, and converging.
 *
 * Thresholds follow widely used residential guidance — ADA/ANSI A117.1 and
 * ISO 21542 for clearances, and typical habitable-room minimums. Groundplan is
 * a design aid, not a code compliance certificate.
 */

import { CATALOG_BY_TYPE, ROOM_TYPES } from './catalog';
import {
  approachRect,
  areaM2,
  doorSwingRect,
  furnitureRect,
  furnitureRoom,
  openingNeighbour,
  openingRect,
  overlapRect,
  rectArea,
  rectCentre,
  roomRect,
} from './geometry';
import {
  doorClearWidth,
  maxClearanceIn,
  rasterise,
  reachableFrom,
  roomReachRatio,
  routeInto,
  widestPaths,
  type Grid,
  type Reachability,
  type RouteField,
} from './grid';
import type { Plan, Room, Violation } from './types';

export interface RoomStats {
  id: string;
  name: string;
  type: string;
  areaM2: number;
  widthMm: number;
  depthMm: number;
  /** Largest clear circle that fits, mm diameter. */
  turningCircleMm: number;
  /** Centre of that circle — the most open spot, and where the label goes. */
  openX: number;
  openY: number;
  /** Fraction of the room reachable at the plan's mobility radius. */
  reachRatio: number;
  /** Widest body that can reach this room from the entrance, mm. */
  routeWidthMm: number;
  /** What is pinching that route, in words. */
  routeLimit: string | null;
  glazingM2: number;
  doorCount: number;
  windowCount: number;
  furniture: string[];
}

export interface Analysis {
  violations: Violation[];
  grid: Grid;
  reach: Reachability;
  /** Widest-path field from the entrance, used to name route bottlenecks. */
  route: RouteField;
  stats: {
    totalAreaM2: number;
    reachableAreaM2: number;
    reachableRatio: number;
    roomCount: number;
    errorCount: number;
    warningCount: number;
    /** 0-100 headline number shown in the UI and returned by check_plan. */
    score: number;
  };
  rooms: RoomStats[];
}

const WINDOW_DEFAULT_SILL = 900;
const WINDOW_DEFAULT_HEAD = 2100;

function windowAreaM2(op: { width: number; sill?: number; head?: number }): number {
  const h = (op.head ?? WINDOW_DEFAULT_HEAD) - (op.sill ?? WINDOW_DEFAULT_SILL);
  return Math.max(0, (op.width * h) / 1_000_000);
}

function round(v: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export function analyse(plan: Plan): Analysis {
  const grid = rasterise(plan);
  const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
  const route = widestPaths(grid, reach.seed);
  const v: Violation[] = [];
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));

  // ── Rooms must not overlap ────────────────────────────────────────────────
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const a = plan.rooms[i]!;
      const b = plan.rooms[j]!;
      const ov = overlapRect(roomRect(a), roomRect(b));
      if (ov && rectArea(ov) > 0) {
        v.push({
          rule: 'room.overlap',
          severity: 'error',
          title: `${a.name} overlaps ${b.name}`,
          detail: `The two rooms share ${areaM2(ov)} m² of floor. Rooms must meet edge to edge, not intersect.`,
          entities: [a.id, b.id],
          measured: areaM2(ov),
          required: 0,
          unit: 'm2',
          fix: `Call edit_room on "${b.name}" with dx_mm/dy_mm so its rectangle only touches "${a.name}" instead of crossing it.`,
          at: rectCentre(ov),
        });
      }
    }
  }

  // ── Room size and proportion ──────────────────────────────────────────────
  for (const room of plan.rooms) {
    const meta = ROOM_TYPES[room.type];
    const a = areaM2(roomRect(room));
    if (a < meta.minArea) {
      v.push({
        rule: 'room.min_area',
        severity: 'error',
        title: `${room.name} is undersized`,
        detail: `${a} m² of floor against a ${meta.minArea} m² minimum for a ${meta.label.toLowerCase()}.`,
        entities: [room.id],
        measured: a,
        required: meta.minArea,
        unit: 'm2',
        fix: `Call edit_room on "${room.name}" with a bigger width_mm/depth_mm, or change its type.`,
        at: rectCentre(roomRect(room)),
      });
    }
    const minDim = Math.min(room.w, room.h);
    if (minDim < meta.minDimension) {
      v.push({
        rule: 'room.min_dimension',
        severity: 'warning',
        title: `${room.name} is too narrow`,
        detail: `Narrowest clear dimension is ${minDim} mm; a ${meta.label.toLowerCase()} wants at least ${meta.minDimension} mm.`,
        entities: [room.id],
        measured: minDim,
        required: meta.minDimension,
        unit: 'mm',
        fix: `Call edit_room on "${room.name}" so both width_mm and depth_mm are at least ${meta.minDimension} mm.`,
        at: rectCentre(roomRect(room)),
      });
    }
  }

  // ── Every room needs a way in ─────────────────────────────────────────────
  const doorsByRoom = new Map<string, number>();
  for (const op of plan.openings) {
    if (op.kind === 'window') continue;
    doorsByRoom.set(op.roomId, (doorsByRoom.get(op.roomId) ?? 0) + 1);
    const other = openingNeighbour(plan, op);
    if (other) doorsByRoom.set(other, (doorsByRoom.get(other) ?? 0) + 1);
  }
  for (const room of plan.rooms) {
    if (!doorsByRoom.get(room.id)) {
      v.push({
        rule: 'room.no_door',
        severity: 'error',
        title: `${room.name} has no door`,
        detail: 'The room is sealed — nothing connects it to the rest of the plan.',
        entities: [room.id],
        measured: 0,
        required: 1,
        unit: 'count',
        fix: `Call add_opening with kind="door", room="${room.name}" and to_room set to a neighbour it shares a wall with.`,
        at: rectCentre(roomRect(room)),
      });
    }
  }

  const exteriorDoors = plan.openings.filter(
    (o) => o.kind === 'door' && openingNeighbour(plan, o) === null,
  );
  if (exteriorDoors.length === 0 && plan.rooms.length > 0) {
    v.push({
      rule: 'plan.no_entry',
      severity: 'error',
      title: 'The home has no front door',
      detail: 'No door sits on an external wall, so nobody can get in or out.',
      entities: [],
      measured: 0,
      required: 1,
      unit: 'count',
      fix: 'Call add_opening with kind="door" and exterior=true on a hall or living room.',
    });
  }

  // ── Doorway clear widths ──────────────────────────────────────────────────
  for (const op of plan.openings) {
    if (op.kind === 'window') continue;
    const clear = doorClearWidth(plan, grid, op.id);
    if (clear < plan.settings.minClearDoor) {
      const room = byId.get(op.roomId);
      const r = openingRect(plan, op);
      v.push({
        rule: 'door.clear_width',
        severity: 'error',
        title: `Doorway into ${room?.name ?? 'a room'} is too tight`,
        detail: `${clear} mm of clear opening against the ${plan.settings.minClearDoor} mm this plan is checked to. A wheelchair or a stretcher will not pass.`,
        entities: [op.id, op.roomId],
        measured: clear,
        required: plan.settings.minClearDoor,
        unit: 'mm',
        fix: `Call edit_opening on ${op.id} with width_mm ${plan.settings.minClearDoor + 85}, or fix_violation with rule "door.clear_width".`,
        at: r ? rectCentre(r) : undefined,
      });
    }
  }

  // ── Reachability and turning circles ──────────────────────────────────────
  const door = plan.settings.mobilityRadius * 2;
  for (const room of plan.rooms) {
    const ratio = roomReachRatio(grid, reach, room);
    const meta = ROOM_TYPES[room.type];
    if (ratio < 0.05) {
      // Name the culprit. "Unreachable" is a symptom; the pinch point is the bug.
      const neck = findBottleneck(plan, grid, route, room);
      v.push({
        rule: 'access.unreachable',
        severity: 'error',
        title: `${room.name} is unreachable`,
        detail: neck
          ? `The best route from the entrance narrows to ${neck.widthMm} mm at ${neck.description}. A ${door} mm-wide body will not pass.`
          : `Nothing connects this room to the entrance at all.`,
        entities: neck?.openingId ? [room.id, neck.openingId] : [room.id],
        measured: neck?.widthMm ?? 0,
        required: door,
        unit: 'mm',
        fix: neck?.openingId
          ? `Call edit_opening on ${neck.openingId} with width_mm ${Math.max(plan.settings.minClearDoor + 85, door + 100)}, or fix_violation with rule "access.unreachable".`
          : `Call fix_violation with rule "access.unreachable", or analyse_access to see the whole route.`,
        at: neck?.at ?? rectCentre(roomRect(room)),
      });
    } else if (ratio < 0.6) {
      v.push({
        rule: 'access.partial',
        severity: 'warning',
        title: `Only ${Math.round(ratio * 100)}% of ${room.name} is usable`,
        detail: 'Furniture leaves most of this room out of reach for a wheelchair user.',
        entities: [room.id],
        measured: round(ratio * 100),
        required: 60,
        unit: 'ratio',
        fix: `Call edit_furniture to shift what is in "${room.name}" against the walls, or delete_entity to remove it.`,
        at: rectCentre(roomRect(room)),
      });
    }

    if (meta.needsTurningCircle) {
      const best = maxClearanceIn(grid, roomRect(room));
      const circle = Math.round(best.value * 2);
      if (circle < plan.settings.turningCircle) {
        v.push({
          rule: 'access.turning_circle',
          severity: circle < plan.settings.turningCircle - 300 ? 'error' : 'warning',
          title: `No turning circle in ${room.name}`,
          detail: `Largest clear circle is ${circle} mm across; ${plan.settings.turningCircle} mm is needed to turn a wheelchair on the spot.`,
          entities: [room.id],
          measured: circle,
          required: plan.settings.turningCircle,
          unit: 'mm',
          fix: `Call fix_violation with rule "access.turning_circle" to re-park the furniture, or edit_room to make "${room.name}" bigger.`,
          at: { x: best.x, y: best.y },
        });
      }
    }
  }

  // ── Daylight and escape ───────────────────────────────────────────────────
  for (const room of plan.rooms) {
    const meta = ROOM_TYPES[room.type];
    if (!meta.habitable || meta.minGlazingRatio === 0) continue;
    const windows = plan.openings.filter(
      (o) => o.kind === 'window' && o.roomId === room.id && openingNeighbour(plan, o) === null,
    );
    const glazing = windows.reduce((sum, w) => sum + windowAreaM2(w), 0);
    const floor = areaM2(roomRect(room));
    const needed = round(floor * meta.minGlazingRatio, 2);
    if (glazing < needed) {
      v.push({
        rule: 'room.daylight',
        severity: windows.length === 0 ? 'error' : 'warning',
        title: `${room.name} is short of daylight`,
        detail: `${round(glazing, 2)} m² of glazing for ${floor} m² of floor; habitable rooms want ${Math.round(meta.minGlazingRatio * 100)}% (${needed} m²).`,
        entities: [room.id],
        measured: round(glazing, 2),
        required: needed,
        unit: 'm2',
        fix: `Call add_opening with kind="window", exterior=true and room="${room.name}" — a 1200 mm window adds 1.44 m².`,
        at: rectCentre(roomRect(room)),
      });
    }
    if (room.type === 'bedroom' && windows.length === 0) {
      v.push({
        rule: 'bedroom.egress',
        severity: 'error',
        title: `${room.name} has no escape window`,
        detail: 'A bedroom on an external wall needs an openable window as a secondary means of escape.',
        entities: [room.id],
        measured: 0,
        required: 1,
        unit: 'count',
        fix: `Call add_opening with kind="window", exterior=true, room="${room.name}" and width_mm at least 900.`,
        at: rectCentre(roomRect(room)),
      });
    }
  }

  // ── Furniture placement ───────────────────────────────────────────────────
  for (const f of plan.furniture) {
    const fr = furnitureRect(f);
    const home = furnitureRoom(plan, f);
    const inside = home ? overlapRect(fr, roomRect(home)) : null;
    const coverage = inside ? rectArea(inside) / rectArea(fr) : 0;
    if (coverage < 0.98) {
      v.push({
        rule: 'furniture.outside',
        severity: 'error',
        title: `${f.label} sticks through a wall`,
        detail: home
          ? `${Math.round((1 - coverage) * 100)}% of its footprint lies outside ${home.name}.`
          : 'The item is not inside any room.',
        entities: [f.id],
        measured: round(coverage * 100),
        required: 100,
        unit: 'ratio',
        fix: `Call edit_furniture on "${f.label}" with x_mm/y_mm inside the room.`,
        at: rectCentre(fr),
      });
    }

    const approach = approachRect(f);
    if (approach) {
      const zone = approachShrink(approach);
      const zoneArea = rectArea(zone);
      const blockers = plan.furniture.filter((o) => {
        if (o.id === f.id) return false;
        if (CATALOG_BY_TYPE.get(o.type)?.blocksApproach === false) return false;
        const ov = overlapRect(zone, furnitureRect(o));
        // Clipping a corner is not "in the way"; taking a fifth of it is.
        return ov !== null && rectArea(ov) / zoneArea > 0.2;
      });
      // Facing a wall counts too: the clear floor has to be inside the room.
      const walled = home ? !contains(roomRect(home), zone) : true;
      if (blockers.length > 0 || walled) {
        v.push({
          rule: 'furniture.approach',
          severity: 'warning',
          title: `No room to use the ${f.label.toLowerCase()}`,
          detail: blockers.length
            ? `${blockers.map((b) => b.label).join(', ')} sits in the ${f.approach} mm of clear floor needed in front of it.`
            : `It faces a wall — the ${f.approach} mm of clear floor it needs in front runs outside the room.`,
          entities: [f.id, ...blockers.map((b) => b.id)],
          measured: Math.round(maxClearanceIn(grid, zone).value * 2),
          required: f.approach,
          unit: 'mm',
          fix: `Call edit_furniture on "${f.label}" and rotate it so its front faces open floor.`,
          at: rectCentre(approach),
        });
      }
    }
  }

  for (let i = 0; i < plan.furniture.length; i++) {
    for (let j = i + 1; j < plan.furniture.length; j++) {
      const a = plan.furniture[i]!;
      const b = plan.furniture[j]!;
      if (tuckable(a, b)) continue;
      const ov = overlapRect(furnitureRect(a), furnitureRect(b));
      if (!ov) continue;
      const smaller = Math.min(rectArea(furnitureRect(a)), rectArea(furnitureRect(b)));
      if (rectArea(ov) / smaller < 0.05) continue;
      v.push({
        rule: 'furniture.overlap',
        severity: 'error',
        title: `${a.label} and ${b.label} occupy the same floor`,
        detail: `They overlap by ${areaM2(ov)} m².`,
        entities: [a.id, b.id],
        measured: areaM2(ov),
        required: 0,
        unit: 'm2',
        fix: `Call edit_furniture on "${b.label}" to move it clear.`,
        at: rectCentre(ov),
      });
    }
  }

  // ── Door swings ───────────────────────────────────────────────────────────
  for (const op of plan.openings) {
    const swing = doorSwingRect(plan, op);
    if (!swing) continue;
    const hits = plan.furniture.filter((f) => {
      const ov = overlapRect(swing, furnitureRect(f));
      return ov !== null && rectArea(ov) / rectArea(swing) > 0.08;
    });
    if (hits.length > 0) {
      v.push({
        rule: 'door.swing_clash',
        severity: 'warning',
        title: `Door fouls ${hits.map((h) => h.label).join(', ')}`,
        detail: 'The leaf cannot open fully without hitting furniture.',
        entities: [op.id, ...hits.map((h) => h.id)],
        fix: `Call edit_opening on ${op.id} with the opposite swing, or fix_violation with rule "door.swing_clash".`,
        at: rectCentre(swing),
      });
    }
  }

  // ── Kitchen work triangle (advisory) ──────────────────────────────────────
  for (const room of plan.rooms.filter((r) => r.type === 'kitchen')) {
    const inRoom = plan.furniture.filter((f) => furnitureRoom(plan, f)?.id === room.id);
    const sink = inRoom.find((f) => f.type === 'sink_kitchen');
    const hob = inRoom.find((f) => f.type === 'oven');
    const fridge = inRoom.find((f) => f.type === 'fridge');
    if (sink && hob && fridge) {
      const d = (a: typeof sink, b: typeof sink) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
      const perimeter = Math.round(d(sink, hob) + d(hob, fridge) + d(fridge, sink));
      if (perimeter < 3600 || perimeter > 6600) {
        v.push({
          rule: 'kitchen.work_triangle',
          severity: 'info',
          title: `Kitchen work triangle is ${perimeter < 3600 ? 'cramped' : 'stretched'}`,
          detail: `Sink, hob and fridge form a ${round(perimeter / 1000, 2)} m triangle; 3.6–6.6 m is the comfortable range.`,
          entities: [room.id, sink.id, hob.id, fridge.id],
          measured: perimeter,
          required: perimeter < 3600 ? 3600 : 6600,
          unit: 'mm',
          fix: `Call edit_furniture on the fridge or hob in "${room.name}" to bring the triangle into range.`,
          at: rectCentre(roomRect(room)),
        });
      }
    }
  }

  // ── Whole-plan circulation ────────────────────────────────────────────────
  if (plan.rooms.length > 1 && reach.ratio < 0.85 && reach.seed >= 0) {
    v.push({
      rule: 'plan.circulation',
      severity: 'warning',
      title: `${Math.round(reach.ratio * 100)}% of the home is step-free reachable`,
      detail: `${round(reach.areaM2, 1)} m² of ${round(reach.totalM2, 1)} m² can be reached with a ${plan.settings.mobilityRadius * 2} mm turning body.`,
      entities: [],
      measured: round(reach.ratio * 100),
      required: 85,
      unit: 'ratio',
      fix: 'Call analyse_access to see which rooms are cut off, then widen the doors on those routes.',
    });
  }

  const errorCount = v.filter((x) => x.severity === 'error').length;
  const warningCount = v.filter((x) => x.severity === 'warning').length;
  // Errors and warnings cost the most; on top of that, a home loses marks for
  // floor nobody can get to. The 90% allowance is the floor that sits under
  // wardrobes and behind beds, which no plan ever reclaims.
  const unreachablePenalty = Math.max(0, 0.9 - reach.ratio) * 50;
  const score = Math.max(
    0,
    Math.round(100 - errorCount * 12 - warningCount * 4 - unreachablePenalty),
  );

  return {
    violations: v.sort(bySeverity),
    grid,
    reach,
    route,
    stats: {
      totalAreaM2: round(reach.totalM2, 1),
      reachableAreaM2: round(reach.areaM2, 1),
      reachableRatio: round(reach.ratio, 3),
      roomCount: plan.rooms.length,
      errorCount,
      warningCount,
      score,
    },
    rooms: plan.rooms.map((room) => roomStats(plan, grid, reach, route, room)),
  };
}

/**
 * The tightest point on the best route into a room, and what is causing it.
 * Naming the culprit — usually one specific door — is what lets an agent fix
 * the right thing on the first try instead of widening every door in the flat.
 */
export interface Bottleneck {
  /** Passage width available on the best route, mm. */
  widthMm: number;
  at: { x: number; y: number };
  /** The opening responsible, when the pinch is in a doorway. */
  openingId?: string;
  /** A phrase that can be dropped straight into a sentence. */
  description: string;
}

export function findBottleneck(
  plan: Plan,
  grid: Grid,
  route: RouteField,
  room: Room,
): Bottleneck | null {
  const result = routeInto(grid, route, roomRect(room));
  if (!result) return null;

  // Every cell on the route that is as tight as the route itself is equally
  // "the bottleneck". Ties are common — a 900 mm door and the 900 mm of floor
  // just past it measure the same — so we look for a doorway among them, and
  // take the one nearest the room, which is the one worth widening.
  const tolerance = 30;
  const doorways = plan.openings.filter((o) => o.kind !== 'window');
  const rects = new Map(doorways.map((o) => [o.id, openingRect(plan, o)] as const));
  const pad = 120;

  for (let k = result.path.length - 1; k >= 0; k--) {
    const cell = result.path[k]!;
    if (grid.clearance[cell]! > result.radiusMm + tolerance) continue;
    const cx = cell % grid.cols;
    const cy = (cell - cx) / grid.cols;
    const px = grid.ox + (cx + 0.5) * grid.cell;
    const py = grid.oy + (cy + 0.5) * grid.cell;
    for (const op of doorways) {
      const r = rects.get(op.id);
      if (!r) continue;
      if (px < r.x - pad || px > r.x + r.w + pad || py < r.y - pad || py > r.y + r.h + pad) continue;
      const host = plan.rooms.find((x) => x.id === op.roomId);
      const other = plan.rooms.find((x) => x.id === openingNeighbour(plan, op));
      const between = other ? `${host?.name} and ${other.name}` : `${host?.name} and outside`;
      return {
        widthMm: result.widthMm,
        at: { x: px, y: py },
        openingId: op.id,
        description: `the ${op.kind} between ${between}`,
      };
    }
  }

  // Not a doorway: something is parked in the way.
  const near = plan.furniture
    .map((f) => ({ f, d: Math.hypot(f.cx - result.pinch.x, f.cy - result.pinch.y) }))
    .filter((x) => x.d < 1400)
    .sort((a, b) => a.d - b.d)[0];
  const where = plan.rooms.find((r) => {
    const rect = roomRect(r);
    return (
      result.pinch.x >= rect.x && result.pinch.x <= rect.x + rect.w &&
      result.pinch.y >= rect.y && result.pinch.y <= rect.y + rect.h
    );
  });
  return {
    widthMm: result.widthMm,
    at: result.pinch,
    description: near
      ? `the gap beside the ${near.f.label.toLowerCase()} in ${where?.name ?? 'the plan'}`
      : `a ${result.widthMm} mm pinch in ${where?.name ?? 'the plan'}`,
  };
}

/** Chairs tucked under a table are not a collision. */
function tuckable(a: { type: string }, b: { type: string }): boolean {
  const pair = [a.type, b.type];
  const isChair = (t: string) => t === 'dining_chair' || t === 'armchair';
  const isTable = (t: string) => t.startsWith('dining_table') || t === 'desk' || t === 'coffee_table';
  return (
    (isChair(pair[0]!) && isTable(pair[1]!)) || (isChair(pair[1]!) && isTable(pair[0]!))
  );
}

/** True when the inner rectangle sits entirely within the outer one. */
function contains(outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 &&
    inner.y + inner.h <= outer.y + outer.h + 1
  );
}

/** Trims a hair off an approach zone so touching edges do not read as clashes. */
function approachShrink(r: { x: number; y: number; w: number; h: number }) {
  return { x: r.x + 30, y: r.y + 30, w: Math.max(10, r.w - 60), h: Math.max(10, r.h - 60) };
}

function bySeverity(a: Violation, b: Violation): number {
  const rank = { error: 0, warning: 1, info: 2 };
  return rank[a.severity] - rank[b.severity];
}

function roomStats(
  plan: Plan,
  grid: Grid,
  reach: Reachability,
  route: RouteField,
  room: Room,
): RoomStats {
  const neck = findBottleneck(plan, grid, route, room);
  const openings = plan.openings.filter(
    (o) => o.roomId === room.id || openingNeighbour(plan, o) === room.id,
  );
  const best = maxClearanceIn(grid, roomRect(room));
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    areaM2: areaM2(roomRect(room)),
    widthMm: room.w,
    depthMm: room.h,
    turningCircleMm: Math.round(best.value * 2),
    openX: Math.round(best.x),
    openY: Math.round(best.y),
    reachRatio: round(roomReachRatio(grid, reach, room), 2),
    routeWidthMm: neck?.widthMm ?? 0,
    routeLimit: neck?.description ?? null,
    glazingM2: round(
      openings.filter((o) => o.kind === 'window').reduce((s, w) => s + windowAreaM2(w), 0),
      2,
    ),
    doorCount: openings.filter((o) => o.kind !== 'window').length,
    windowCount: openings.filter((o) => o.kind === 'window').length,
    furniture: plan.furniture.filter((f) => furnitureRoom(plan, f)?.id === room.id).map((f) => f.label),
  };
}

/**
 * Journeys.
 *
 * `analyse_access` can tell you that a bathroom is unreachable and that the
 * door is 800 mm. That is the correct answer, and almost nobody feels it.
 *
 * This module turns the same numbers into a trip: a body of a stated width
 * setting off from the front door, following the widest route the home allows,
 * and stopping — visibly, at scale, on the drawing — at the exact point where
 * it no longer fits. It is the same widest-path field the rule engine uses. The
 * only thing added is time.
 */

import { pointInRect, roomRect } from './geometry';
import { entryPoint, reachableFrom, routeInto, widestPaths, type Grid } from './grid';
import type { Plan } from './types';

export interface Journey {
  targetRoomId: string;
  targetRoomName: string;
  /** Body radius being tested, mm. */
  radius: number;
  /** Centre-line of the route, entrance first, in world mm. */
  points: { x: number; y: number }[];
  /** Clear radius available at each point, mm. */
  clearance: number[];
  /** Cumulative distance along the route at each point, mm. */
  travelled: number[];
  /** Index of the last point the body can actually occupy. */
  stopIndex: number;
  /** True when the body gets all the way there. */
  arrives: boolean;
  /** Passage width available on this route, mm. */
  widthMm: number;
  /** Where it runs out of room, when it does. */
  pinch: { x: number; y: number } | null;
  /** Rooms passed through, in order. */
  rooms: string[];
  /** How far the body actually gets, mm. */
  distanceMm: number;
  /** Length of the whole route, whether or not the body can walk it, mm. */
  fullDistanceMm: number;
}

/** Every third cell is plenty for a smooth path and keeps the array small. */
const SAMPLE = 3;

export function planJourney(
  plan: Plan,
  grid: Grid,
  roomRef: string,
  radiusMm: number,
): Journey | null {
  const room = plan.rooms.find((r) => r.id === roomRef);
  if (!room) return null;

  // Start somewhere this body can actually stand. Seeding with the tested
  // radius makes `reachableFrom` nudge off the doormat into the hall; if even
  // that fails, fall back to a narrower body so we can still show *where* the
  // trip goes wrong rather than refusing to draw anything.
  let seed = reachableFrom(plan, grid, radiusMm).seed;
  if (seed < 0) seed = reachableFrom(plan, grid, 250).seed;
  if (seed < 0) seed = seedFromEntry(plan, grid);
  if (seed < 0) return null;

  const field = widestPaths(grid, seed);
  const result = routeInto(grid, field, roomRect(room));
  if (!result || result.path.length === 0) return null;

  const points: { x: number; y: number }[] = [];
  const clearance: number[] = [];
  for (let i = 0; i < result.path.length; i += SAMPLE) {
    const cell = result.path[i]!;
    const cx = cell % grid.cols;
    const cy = (cell - cx) / grid.cols;
    points.push({ x: grid.ox + (cx + 0.5) * grid.cell, y: grid.oy + (cy + 0.5) * grid.cell });
    clearance.push(grid.clearance[cell]!);
  }
  const lastCell = result.path[result.path.length - 1]!;
  const lx = lastCell % grid.cols;
  const ly = (lastCell - lx) / grid.cols;
  points.push({ x: grid.ox + (lx + 0.5) * grid.cell, y: grid.oy + (ly + 0.5) * grid.cell });
  clearance.push(grid.clearance[lastCell]!);

  const travelled: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    travelled.push(
      travelled[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y),
    );
  }

  // Walk forward until the body no longer fits.
  let stopIndex = points.length - 1;
  let arrives = true;
  for (let i = 0; i < clearance.length; i++) {
    if (clearance[i]! < radiusMm) {
      stopIndex = Math.max(0, i - 1);
      arrives = false;
      break;
    }
  }

  const rooms: string[] = [];
  for (let i = 0; i <= stopIndex; i++) {
    const here = plan.rooms.find((r) => pointInRect(points[i]!.x, points[i]!.y, roomRect(r)));
    if (here && rooms[rooms.length - 1] !== here.name) rooms.push(here.name);
  }

  return {
    targetRoomId: room.id,
    targetRoomName: room.name,
    radius: radiusMm,
    points,
    clearance,
    travelled,
    stopIndex,
    arrives,
    widthMm: result.widthMm,
    pinch: arrives ? null : (points[Math.min(stopIndex + 1, points.length - 1)] ?? result.pinch),
    rooms,
    distanceMm: Math.round(travelled[stopIndex] ?? 0),
    fullDistanceMm: Math.round(travelled[travelled.length - 1] ?? 0),
  };
}

function seedFromEntry(plan: Plan, grid: Grid): number {
  const entry = entryPoint(plan, grid);
  if (!entry) return -1;
  const cx = Math.floor((entry.x - grid.ox) / grid.cell);
  const cy = Math.floor((entry.y - grid.oy) / grid.cell);
  if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return -1;
  return cy * grid.cols + cx;
}

/** Where the body is after travelling `distance` along the journey. */
export function positionAt(journey: Journey, distance: number): { x: number; y: number; index: number } {
  const limit = journey.travelled[journey.stopIndex] ?? 0;
  const d = Math.max(0, Math.min(distance, limit));
  let i = 0;
  while (i < journey.stopIndex && journey.travelled[i + 1]! < d) i++;
  const from = journey.points[i]!;
  const to = journey.points[Math.min(i + 1, journey.stopIndex)] ?? from;
  const span = (journey.travelled[Math.min(i + 1, journey.stopIndex)] ?? 0) - journey.travelled[i]!;
  const t = span > 0 ? (d - journey.travelled[i]!) / span : 0;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, index: i };
}

/** One sentence a person or an agent can read without looking at the drawing. */
export function describeJourney(journey: Journey, targetDiameter: number): string {
  const metres = (journey.distanceMm / 1000).toFixed(1);
  if (journey.arrives) {
    return `A ${targetDiameter} mm body reaches ${journey.targetRoomName} — ${metres} m through ${journey.rooms.join(
      ' → ',
    )}, with ${journey.widthMm} mm to spare at the tightest point.`;
  }
  return `A ${targetDiameter} mm body gets as far as ${
    journey.rooms[journey.rooms.length - 1] ?? 'the entrance'
  } and stops after ${metres} m: the route narrows to ${journey.widthMm} mm, and it needs ${targetDiameter} mm.`;
}

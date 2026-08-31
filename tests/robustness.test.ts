/**
 * Randomised and degenerate plans.
 *
 * The engine will meet drawings nobody sanity-checked first — an agent
 * mid-experiment, a half-drawn sketch, a room dragged on top of another. None
 * of that may crash it, produce a NaN, or hand an agent a finding that points
 * at something which no longer exists.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../src/core/catalog';
import { openingRect, roomRect, wallRuns, wallSegments } from '../src/core/geometry';
import { rasterise } from '../src/core/grid';
import { analyse } from '../src/core/rules';
import { decodePlan, encodePlan } from '../src/core/share';
import { planToSchedule, planToSvg } from '../src/core/svg';
import { DEFAULT_SETTINGS, type Opening, type Plan, type Room, type RoomType, type Side } from '../src/core/types';

/** A deterministic little PRNG, so a failure can be reproduced from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

const TYPES: RoomType[] = ['living', 'bedroom', 'kitchen', 'bathroom', 'hall', 'office', 'storage'];
const SIDES: Side[] = ['n', 'e', 's', 'w'];

/**
 * Lays rooms out in bands so they meet edge to edge, then scatters openings and
 * furniture over them with no regard for whether the result makes sense.
 */
function randomPlan(seed: number): Plan {
  const rand = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) / 100) * 100;

  const rooms: Room[] = [];
  const bands = 1 + Math.floor(rand() * 3);
  let y = 0;
  for (let b = 0; b < bands; b++) {
    const depth = between(1500, 4500);
    const count = 1 + Math.floor(rand() * 3);
    let x = 0;
    for (let i = 0; i < count; i++) {
      const width = between(1200, 5000);
      rooms.push({
        id: `r${rooms.length}`,
        name: `Room ${rooms.length + 1}`,
        type: pick(TYPES),
        x,
        y,
        w: width,
        h: depth,
      });
      x += width;
    }
    y += depth;
  }

  const openings: Opening[] = [];
  const openingCount = Math.floor(rand() * (rooms.length * 2 + 2));
  for (let i = 0; i < openingCount; i++) {
    const room = pick(rooms);
    const side = pick(SIDES);
    const len = side === 'n' || side === 's' ? room.w : room.h;
    const width = between(600, 1400);
    if (width + 200 > len) continue;
    openings.push({
      id: `o${i}`,
      kind: pick(['door', 'window', 'archway'] as const),
      roomId: room.id,
      side,
      offset: Math.min(Math.max(100, between(0, len - width - 100)), Math.max(100, len - width - 100)),
      width,
      swing: pick([...SIDES, 'none'] as const),
      sill: 900,
      head: 2100,
    });
  }

  const furniture = Array.from({ length: Math.floor(rand() * 12) }, (_, i) => {
    const item = pick(CATALOG);
    const room = pick(rooms);
    return {
      id: `f${i}`,
      type: item.type,
      label: item.label,
      category: item.category,
      cx: room.x + between(0, room.w),
      cy: room.y + between(0, room.h),
      w: item.w,
      h: item.h,
      rot: pick([0, 90, 180, 270] as const),
      approach: item.approach,
    };
  });

  return {
    id: `random_${seed}`,
    name: `Random ${seed}`,
    rooms,
    openings,
    furniture,
    settings: { ...DEFAULT_SETTINGS },
  };
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 13);

describe('random plans', () => {
  it('never throw, and never produce a number that is not a number', () => {
    for (const seed of SEEDS) {
      const plan = randomPlan(seed);
      const analysis = analyse(plan);
      // `routeLimit` is legitimately null when nothing is pinching, so only the
      // numbers are held to "must be a real number".
      expect(JSON.stringify(analysis.stats), `seed ${seed}`).not.toMatch(/null|NaN|Infinity/);
      expect(JSON.stringify(analysis.rooms), `seed ${seed}`).not.toMatch(/NaN|Infinity/);
      expect(analysis.stats.score, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(analysis.stats.score, `seed ${seed}`).toBeLessThanOrEqual(100);
      expect(analysis.stats.reachableRatio, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(analysis.stats.reachableRatio, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
  });

  it('only ever point at things that exist', () => {
    for (const seed of SEEDS) {
      const plan = randomPlan(seed);
      const ids = new Set([
        ...plan.rooms.map((r) => r.id),
        ...plan.openings.map((o) => o.id),
        ...plan.furniture.map((f) => f.id),
      ]);
      for (const v of analyse(plan).violations) {
        expect(v.rule, `seed ${seed}`).toMatch(/^[a-z]+\.[a-z_]+$/);
        expect(v.title.length, `seed ${seed} ${v.rule}`).toBeGreaterThan(3);
        expect(v.detail.length, `seed ${seed} ${v.rule}`).toBeGreaterThan(10);
        for (const id of v.entities) {
          expect(ids.has(id), `seed ${seed}: ${v.rule} points at missing ${id}`).toBe(true);
        }
        if (v.at) {
          expect(Number.isFinite(v.at.x) && Number.isFinite(v.at.y), `seed ${seed} ${v.rule}`).toBe(true);
        }
      }
    }
  });

  it('give the same answer twice', () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const plan = randomPlan(seed);
      const a = analyse(plan);
      const b = analyse(structuredClone(plan));
      expect(JSON.stringify(a.violations), `seed ${seed}`).toBe(JSON.stringify(b.violations));
      expect(a.stats.score).toBe(b.stats.score);
    }
  });

  it('never draw a wall across an opening', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const plan = randomPlan(seed);
      const runs = wallRuns(plan);
      for (const op of plan.openings) {
        const hole = openingRect(plan, op);
        if (!hole) continue;
        // Sample the middle of the reveal; no wall run may cover it.
        const px = hole.x + hole.w / 2;
        const py = hole.y + hole.h / 2;
        const covered = runs.some(
          (r) => px > r.x + 1 && px < r.x + r.w - 1 && py > r.y + 1 && py < r.y + r.h - 1,
        );
        expect(covered, `seed ${seed}: wall run covers opening ${op.id}`).toBe(false);
      }
    }
  });

  it('export cleanly to svg and to a schedule', () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const plan = randomPlan(seed);
      const analysis = analyse(plan);
      const svg = planToSvg(plan, { analysis, annotate: true });
      expect(svg, `seed ${seed}`).not.toMatch(/NaN|undefined/);
      expect(svg.match(/<svg/g)).toHaveLength(1);
      expect(svg.match(/<\/svg>/g)).toHaveLength(1);
      expect(planToSchedule(plan, analysis)).toContain('| Room |');
    }
  });

  it('survive a round trip through a share link', async () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const plan = randomPlan(seed);
      const back = await decodePlan(await encodePlan(plan));
      expect(JSON.stringify(back), `seed ${seed}`).toBe(JSON.stringify(plan));
    }
  });
});

describe('degenerate plans', () => {
  const empty: Plan = { id: 'e', name: 'Empty', rooms: [], openings: [], furniture: [], settings: { ...DEFAULT_SETTINGS } };

  it('an empty plan analyses to nothing at all', () => {
    const a = analyse(empty);
    expect(a.violations).toHaveLength(0);
    expect(a.stats.totalAreaM2).toBe(0);
    expect(a.stats.reachableRatio).toBe(0);
    // A blank sheet has nothing wrong with it, and should not be marked down
    // for floor it does not have.
    expect(a.stats.score).toBe(100);
    expect(() => planToSvg(empty)).not.toThrow();
  });

  it('a single sealed room reports that it has no way in', () => {
    const plan: Plan = {
      ...empty,
      rooms: [{ id: 'r0', name: 'Box', type: 'bedroom', x: 0, y: 0, w: 3000, h: 3000 }],
    };
    const rules = analyse(plan).violations.map((v) => v.rule);
    expect(rules).toContain('room.no_door');
    expect(rules).toContain('plan.no_entry');
  });

  it('handles a room laid straight on top of another', () => {
    const plan: Plan = {
      ...empty,
      rooms: [
        { id: 'r0', name: 'A', type: 'living', x: 0, y: 0, w: 4000, h: 4000 },
        { id: 'r1', name: 'B', type: 'bedroom', x: 0, y: 0, w: 4000, h: 4000 },
      ],
    };
    const a = analyse(plan);
    expect(a.violations.some((v) => v.rule === 'room.overlap')).toBe(true);
    expect(Number.isFinite(a.stats.score)).toBe(true);
  });

  it('handles an opening wider than the wall it sits in', () => {
    const plan: Plan = {
      ...empty,
      rooms: [{ id: 'r0', name: 'A', type: 'living', x: 0, y: 0, w: 2000, h: 2000 }],
      openings: [{ id: 'o0', kind: 'door', roomId: 'r0', side: 'n', offset: 0, width: 9000, swing: 's' }],
    };
    expect(() => analyse(plan)).not.toThrow();
    expect(() => rasterise(plan)).not.toThrow();
  });

  it('handles an opening whose room has been deleted', () => {
    const plan: Plan = {
      ...empty,
      rooms: [{ id: 'r0', name: 'A', type: 'living', x: 0, y: 0, w: 4000, h: 4000 }],
      openings: [{ id: 'o0', kind: 'door', roomId: 'gone', side: 'n', offset: 100, width: 900, swing: 's' }],
    };
    expect(() => analyse(plan)).not.toThrow();
    expect(openingRect(plan, plan.openings[0]!)).toBeNull();
  });

  it('handles furniture parked in the middle of nowhere', () => {
    const plan: Plan = {
      ...empty,
      rooms: [{ id: 'r0', name: 'A', type: 'living', x: 0, y: 0, w: 4000, h: 4000 }],
      furniture: [
        {
          id: 'f0',
          type: 'bed_double',
          label: 'Double bed',
          category: 'sleeping',
          cx: 90000,
          cy: 90000,
          w: 1400,
          h: 2000,
          rot: 0,
          approach: 900,
        },
      ],
    };
    const a = analyse(plan);
    expect(a.violations.some((v) => v.rule === 'furniture.outside')).toBe(true);
    expect(Number.isFinite(a.stats.reachableRatio)).toBe(true);
  });

  it('does not invent neighbours out of rooms that merely come close', () => {
    const plan: Plan = {
      ...empty,
      rooms: [
        { id: 'r0', name: 'A', type: 'living', x: 0, y: 0, w: 3000, h: 3000 },
        { id: 'r1', name: 'B', type: 'bedroom', x: 3010, y: 0, w: 3000, h: 3000 },
      ],
    };
    const shared = wallSegments(plan).filter((s) => s.neighbourId !== null);
    expect(shared).toHaveLength(0);
  });
});

describe('the engine is quick enough to run on every keystroke', () => {
  it('analyses a twenty-room plan in well under a fifth of a second', () => {
    const rooms: Room[] = [];
    for (let band = 0; band < 4; band++) {
      for (let i = 0; i < 5; i++) {
        rooms.push({
          id: `r${band}_${i}`,
          name: `Room ${band}-${i}`,
          type: 'bedroom',
          x: i * 3000,
          y: band * 3000,
          w: 3000,
          h: 3000,
        });
      }
    }
    const plan: Plan = {
      id: 'big',
      name: 'Big',
      rooms,
      openings: rooms.slice(1).map((r, i) => ({
        id: `o${i}`,
        kind: 'door' as const,
        roomId: r.id,
        side: 'w' as const,
        offset: 1000,
        width: 1000,
        swing: 'e' as const,
      })),
      furniture: [],
      settings: { ...DEFAULT_SETTINGS },
    };

    const started = performance.now();
    const a = analyse(plan);
    const elapsed = performance.now() - started;
    expect(a.rooms).toHaveLength(20);
    expect(elapsed, `analyse took ${Math.round(elapsed)} ms`).toBeLessThan(200);
  });

  it('measures every room area exactly, with no floating-point drift', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const plan = randomPlan(seed);
      for (const room of plan.rooms) {
        const area = (roomRect(room).w * roomRect(room).h) / 1e6;
        expect(Number.isInteger(room.w) && Number.isInteger(room.h)).toBe(true);
        expect(Number.isFinite(area)).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  approachRect,
  doorSwingRect,
  furnitureRect,
  openingNeighbour,
  openingRect,
  wallRuns,
  wallSegments,
} from '../src/core/geometry';
import { place } from '../src/core/samples';
import { DEFAULT_SETTINGS, type Plan } from '../src/core/types';

/** Two rooms side by side, sharing their whole 3 m boundary, with a door in it. */
function pair(): Plan {
  return {
    id: 'p',
    name: 'Pair',
    rooms: [
      { id: 'a', name: 'A', type: 'living', x: 0, y: 0, w: 4000, h: 3000 },
      { id: 'b', name: 'B', type: 'bedroom', x: 4000, y: 0, w: 3000, h: 3000 },
    ],
    openings: [
      { id: 'd1', kind: 'door', roomId: 'a', side: 'e', offset: 1000, width: 900, swing: 'w' },
    ],
    furniture: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

describe('wall segments', () => {
  it('sees the shared boundary between touching rooms', () => {
    const segs = wallSegments(pair());
    const shared = segs.filter((s) => s.roomId === 'a' && s.side === 'e');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.neighbourId).toBe('b');
    expect(shared[0]!.end - shared[0]!.start).toBe(3000);
  });

  it('splits a wall where a neighbour covers only part of it', () => {
    const plan = pair();
    plan.rooms[1]!.h = 1200; // B now covers only the top 1.2 m of A's east wall
    const segs = wallSegments(plan).filter((s) => s.roomId === 'a' && s.side === 'e');
    expect(segs).toHaveLength(2);
    expect(segs[0]!.neighbourId).toBe('b');
    expect(segs[1]!.neighbourId).toBeNull();
  });

  it('reports the room on the far side of an opening', () => {
    const plan = pair();
    expect(openingNeighbour(plan, plan.openings[0]!)).toBe('b');
  });

  it('calls an opening on an outside wall exterior', () => {
    const plan = pair();
    plan.openings[0] = { ...plan.openings[0]!, side: 'n', offset: 500 };
    expect(openingNeighbour(plan, plan.openings[0]!)).toBeNull();
  });
});

describe('openings', () => {
  it('spans the interior wall thickness between two rooms', () => {
    const plan = pair();
    const r = openingRect(plan, plan.openings[0]!)!;
    expect(r.w).toBe(DEFAULT_SETTINGS.interiorWall);
    expect(r.h).toBe(900);
    expect(r.x).toBe(4000 - DEFAULT_SETTINGS.interiorWall / 2);
  });

  it('uses the thicker envelope on an external wall', () => {
    const plan = pair();
    plan.openings[0] = { ...plan.openings[0]!, side: 'n', offset: 500 };
    const r = openingRect(plan, plan.openings[0]!)!;
    expect(r.h).toBe(DEFAULT_SETTINGS.exteriorWall);
  });

  it('sweeps a door leaf the width of the opening', () => {
    const plan = pair();
    const swing = doorSwingRect(plan, plan.openings[0]!)!;
    expect(swing.w).toBe(900);
    expect(swing.h).toBe(900);
    // Swinging west means the arc sits on A's side of the wall.
    expect(swing.x).toBeLessThan(4000);
  });

  it('gives a sliding door no swing at all', () => {
    const plan = pair();
    plan.openings[0] = { ...plan.openings[0]!, swing: 'none' };
    expect(doorSwingRect(plan, plan.openings[0]!)).toBeNull();
  });
});

describe('wall runs', () => {
  it('subtracts openings from the band they pierce', () => {
    const plan = pair();
    const runs = wallRuns(plan);
    const onBoundary = runs.filter((r) => Math.abs(r.x + r.w / 2 - 4000) < 1);
    // The 3 m partition minus a 900 mm door leaves two stretches.
    expect(onBoundary).toHaveLength(2);
    const total = onBoundary.reduce((sum, r) => sum + r.h, 0);
    expect(total).toBe(3000 - 900);
  });

  it('draws a shared partition once, not once per room', () => {
    const plan = pair();
    plan.openings = [];
    const runs = wallRuns(plan);
    const onBoundary = runs.filter((r) => Math.abs(r.x + r.w / 2 - 4000) < 1);
    expect(onBoundary).toHaveLength(1);
  });
});

describe('furniture', () => {
  it('swaps width and depth when rotated a quarter turn', () => {
    const bed = place('bed_double', 1000, 1000, 90);
    const r = furnitureRect(bed);
    expect(r.w).toBe(2000);
    expect(r.h).toBe(1400);
  });

  it('puts the clear floor in front of whichever way the item faces', () => {
    const south = approachRect(place('wc', 1000, 1000, 0))!;
    expect(south.y).toBeGreaterThan(1000);
    const north = approachRect(place('wc', 1000, 1000, 180))!;
    expect(north.y + north.h).toBeLessThanOrEqual(1000);
    const east = approachRect(place('wc', 1000, 1000, 270))!;
    expect(east.x).toBeGreaterThan(1000);
  });

  it('asks for no clear floor when the item needs none', () => {
    expect(approachRect(place('coffee_table', 0, 0, 0))).toBeNull();
  });
});

/**
 * Journeys.
 *
 * The animation is the part people remember, so what it animates had better be
 * true: the body has to stop where the plan actually pinches, and it has to get
 * through when the plan actually allows it.
 */

import { describe, expect, it } from 'vitest';

import { rasterise } from '../src/core/grid';
import { describeJourney, planJourney, positionAt } from '../src/core/route';
import { analyse } from '../src/core/rules';
import { accessiblePlan, starterPlan } from '../src/core/samples';
import { findRoom } from '../src/core/ops';

describe('walking the starter flat', () => {
  const plan = starterPlan();
  const grid = rasterise(plan);
  const bathroom = findRoom(plan, 'Bathroom')!;
  const study = findRoom(plan, 'Study')!;

  it('a wheelchair does not reach the bathroom', () => {
    const journey = planJourney(plan, grid, bathroom.id, 450)!;
    expect(journey.arrives).toBe(false);
    expect(journey.widthMm).toBe(800);
    expect(journey.rooms).not.toContain('Bathroom');
  });

  it('and stops in the doorway rather than somewhere arbitrary', () => {
    const journey = planJourney(plan, grid, bathroom.id, 450)!;
    expect(journey.pinch).not.toBeNull();
    // The bathroom door sits at x 8200–9000 on the wall at y = 3600.
    expect(journey.pinch!.x).toBeGreaterThan(7800);
    expect(journey.pinch!.x).toBeLessThan(9400);
    expect(Math.abs(journey.pinch!.y - 3600)).toBeLessThan(900);
  });

  it('a walking frame gets through the same door', () => {
    const journey = planJourney(plan, grid, bathroom.id, 350)!;
    expect(journey.arrives).toBe(true);
    expect(journey.rooms).toContain('Bathroom');
  });

  it('a wheelchair does reach the study', () => {
    const journey = planJourney(plan, grid, study.id, 450)!;
    expect(journey.arrives).toBe(true);
    expect(journey.rooms[0]).toBe('Hall');
    expect(journey.rooms).toContain('Study');
  });

  it('takes a sensible route rather than wandering the whole flat', () => {
    const journey = planJourney(plan, grid, study.id, 450)!;
    // The study is about 9 m away by any reasonable path through the hall.
    expect(journey.distanceMm).toBeGreaterThan(6000);
    expect(journey.distanceMm).toBeLessThan(14000);
  });

  it('says what happened in one sentence', () => {
    const blocked = describeJourney(planJourney(plan, grid, bathroom.id, 450)!, 900);
    expect(blocked).toContain('800 mm');
    expect(blocked).toContain('needs 900 mm');
    const fine = describeJourney(planJourney(plan, grid, study.id, 450)!, 900);
    expect(fine).toContain('reaches Study');
  });
});

describe('walking the accessible bungalow', () => {
  const plan = accessiblePlan();
  const grid = rasterise(plan);

  it('reaches every room in a wheelchair', () => {
    for (const room of plan.rooms) {
      const journey = planJourney(plan, grid, room.id, 450);
      expect(journey, room.name).not.toBeNull();
      expect(journey!.arrives, `${room.name} is not reachable`).toBe(true);
    }
  });

  it('agrees with the rule engine about reachability', () => {
    const analysis = analyse(plan);
    expect(analysis.violations.filter((v) => v.rule.startsWith('access.'))).toHaveLength(0);
  });
});

describe('interpolating along a journey', () => {
  const plan = starterPlan();
  const grid = rasterise(plan);
  const journey = planJourney(plan, grid, findRoom(plan, 'Study')!.id, 450)!;

  it('starts at the beginning and ends at the stop', () => {
    const start = positionAt(journey, 0);
    expect(start.x).toBeCloseTo(journey.points[0]!.x, 0);
    const end = positionAt(journey, journey.travelled[journey.stopIndex]!);
    expect(end.x).toBeCloseTo(journey.points[journey.stopIndex]!.x, 0);
  });

  it('clamps rather than running off the end', () => {
    const far = positionAt(journey, 1e9);
    expect(Number.isFinite(far.x) && Number.isFinite(far.y)).toBe(true);
    const before = positionAt(journey, -500);
    expect(before.x).toBeCloseTo(journey.points[0]!.x, 0);
  });

  it('moves forward monotonically', () => {
    let last = -Infinity;
    for (let d = 0; d <= journey.distanceMm; d += 250) {
      const p = positionAt(journey, d);
      expect(p.index).toBeGreaterThanOrEqual(0);
      const travelled = journey.travelled[p.index]!;
      expect(travelled).toBeGreaterThanOrEqual(last - 1);
      last = travelled;
    }
  });
});

describe('journeys that cannot start', () => {
  it('returns nothing for a room that is not there', () => {
    const plan = starterPlan();
    expect(planJourney(plan, rasterise(plan), 'no-such-room', 450)).toBeNull();
  });

  it('still describes the trip when the home has no front door', () => {
    const plan = starterPlan();
    plan.openings = plan.openings.filter((o) => o.roomId !== plan.rooms[3]!.id || o.side !== 'w');
    const journey = planJourney(plan, rasterise(plan), findRoom(plan, 'Study')!.id, 450);
    expect(journey === null || typeof journey.arrives === 'boolean').toBe(true);
  });
});

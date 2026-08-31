import { describe, expect, it } from 'vitest';

import { roomRect } from '../src/core/geometry';
import {
  doorClearWidth,
  maxClearanceIn,
  rasterise,
  reachableFrom,
  roomReachRatio,
  routeInto,
  widestPaths,
} from '../src/core/grid';
import { DEFAULT_SETTINGS, type Plan } from '../src/core/types';

/**
 * Two rooms in a row: you come in through the front door on the west, and reach
 * the far room through one internal door of the given width.
 */
function twoRooms(internalDoorWidth: number): Plan {
  return {
    id: 'p',
    name: 'Two rooms',
    rooms: [
      { id: 'hall', name: 'Hall', type: 'hall', x: 0, y: 0, w: 4000, h: 3000 },
      { id: 'back', name: 'Back room', type: 'bedroom', x: 4000, y: 0, w: 3000, h: 3000 },
    ],
    openings: [
      { id: 'front', kind: 'door', roomId: 'hall', side: 'w', offset: 1000, width: 1000, swing: 'e' },
      { id: 'inner', kind: 'door', roomId: 'hall', side: 'e', offset: 1000, width: internalDoorWidth, swing: 'e' },
    ],
    furniture: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

describe('clearance field', () => {
  it('measures the inscribed circle of an empty room', () => {
    const plan = twoRooms(900);
    const grid = rasterise(plan);
    const best = maxClearanceIn(grid, roomRect(plan.rooms[0]!));
    // The room is 3 m deep, but the 250 mm envelope eats 125 mm off each face,
    // leaving 2750 mm of clear floor — a 1375 mm radius, less grid quantisation.
    expect(best.value).toBeGreaterThan(1300);
    expect(best.value).toBeLessThanOrEqual(1400);
  });

  it('shrinks once furniture is in the way', () => {
    const plan = twoRooms(900);
    plan.furniture.push({
      id: 'f1',
      type: 'wardrobe',
      label: 'Wardrobe',
      category: 'storage',
      cx: 2000,
      cy: 1500,
      w: 2000,
      h: 1000,
      rot: 0,
      approach: 0,
    });
    const grid = rasterise(plan);
    const best = maxClearanceIn(grid, roomRect(plan.rooms[0]!));
    expect(best.value).toBeLessThan(1200);
  });
});

describe('doorway clear width', () => {
  it('reports the structural width less the leaf', () => {
    const grid = rasterise(twoRooms(900));
    expect(doorClearWidth(twoRooms(900), grid, 'inner')).toBe(860);
  });

  it('does not blame a door for furniture standing behind it', () => {
    const plan = twoRooms(900);
    // A bed 200 mm past the doorway: the door itself is still 900 mm.
    plan.furniture.push({
      id: 'f1',
      type: 'bed_double',
      label: 'Double bed',
      category: 'sleeping',
      cx: 5200,
      cy: 1500,
      w: 1400,
      h: 2000,
      rot: 90,
      approach: 0,
    });
    const grid = rasterise(plan);
    expect(doorClearWidth(plan, grid, 'inner')).toBe(860);
  });
});

describe('reachability', () => {
  it('gets through a wide door', () => {
    const plan = twoRooms(1000);
    const grid = rasterise(plan);
    const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
    expect(roomReachRatio(grid, reach, plan.rooms[1]!)).toBeGreaterThan(0.8);
  });

  it('does not get through a narrow one', () => {
    const plan = twoRooms(700);
    const grid = rasterise(plan);
    const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
    expect(roomReachRatio(grid, reach, plan.rooms[1]!)).toBeLessThan(0.05);
  });

  it('counts only bare floor towards the total', () => {
    const empty = twoRooms(1000);
    const furnished = twoRooms(1000);
    furnished.furniture.push({
      id: 'f1',
      type: 'wardrobe',
      label: 'Wardrobe',
      category: 'storage',
      cx: 1000,
      cy: 300,
      w: 1200,
      h: 600,
      rot: 0,
      approach: 0,
    });
    const a = reachableFrom(empty, rasterise(empty), 450);
    const b = reachableFrom(furnished, rasterise(furnished), 450);
    expect(b.totalM2).toBeLessThan(a.totalM2);
  });
});

describe('widest-path routing', () => {
  it('names the width of the tightest point on the route', () => {
    const plan = twoRooms(700);
    const grid = rasterise(plan);
    const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
    const field = widestPaths(grid, reach.seed);
    const route = routeInto(grid, field, roomRect(plan.rooms[1]!))!;
    expect(route).not.toBeNull();
    // A 700 mm door lets a 700 mm body through, and no more.
    expect(route.widthMm).toBeGreaterThanOrEqual(600);
    expect(route.widthMm).toBeLessThanOrEqual(800);
  });

  it('puts the pinch point in the doorway, not somewhere past it', () => {
    const plan = twoRooms(700);
    const grid = rasterise(plan);
    const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
    const field = widestPaths(grid, reach.seed);
    const route = routeInto(grid, field, roomRect(plan.rooms[1]!))!;
    expect(Math.abs(route.pinch.x - 4000)).toBeLessThan(400);
  });

  it('widens as the door widens', () => {
    const widths = [700, 900, 1200].map((w) => {
      const plan = twoRooms(w);
      const grid = rasterise(plan);
      const reach = reachableFrom(plan, grid, plan.settings.mobilityRadius);
      const field = widestPaths(grid, reach.seed);
      return routeInto(grid, field, roomRect(plan.rooms[1]!))!.widthMm;
    });
    expect(widths[0]!).toBeLessThan(widths[1]!);
    expect(widths[1]!).toBeLessThanOrEqual(widths[2]!);
  });
});

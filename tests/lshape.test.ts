/**
 * The L-shaped room workaround, held to the promise made about it.
 *
 * `get_capabilities` tells an agent that an L-shaped space is drawn as two
 * rectangles joined by a wide archway, "measured as one space". That was once
 * only half true: the engine judged the short leg as a room in its own right
 * and failed it on floor area and daylight. Advice a tool punishes you for
 * taking is worse than no advice.
 */

import { describe, expect, it } from 'vitest';

import { findRoom } from '../src/core/ops';
import { analyse, spaces } from '../src/core/rules';
import { emptyPlan } from '../src/core/samples';
import { runBatch } from '../src/mcp/operations';
import type { Plan } from '../src/core/types';

/** An L-shaped living room, built the way the app says to build one. */
function lShaped(): Plan {
  const plan = emptyPlan('L-shaped');
  const result = runBatch(plan, [
    { op: 'add_room', args: { type: 'living', name: 'Living room', width_mm: 5000, depth_mm: 4000 } },
    { op: 'add_room', args: { type: 'living', name: 'Living room leg', width_mm: 2400, depth_mm: 2600, against_room: 'Living room', against_side: 'e' } },
    { op: 'add_opening', args: { room: 'Living room leg', kind: 'archway', to_room: 'Living room', width_mm: 2000 } },
    { op: 'add_opening', args: { room: 'Living room', kind: 'door', side: 'w', exterior: true, width_mm: 1000 } },
    { op: 'add_opening', args: { room: 'Living room', kind: 'window', exterior: true, side: 'n', width_mm: 2400 } },
  ]);
  if (!result.ok) throw new Error(result.error);
  return plan;
}

describe('two rectangles and a wide archway', () => {
  const plan = lShaped();
  const analysis = analyse(plan);
  const leg = findRoom(plan, 'Living room leg')!;

  it('reads as one space', () => {
    const group = spaces(plan).get(leg.id)!;
    expect(group).toHaveLength(2);
    expect(group[0]!.name).toBe('Living room');
  });

  it('does not fail the short leg on floor area', () => {
    const found = analysis.violations.filter((v) => v.rule === 'room.min_area');
    expect(found.map((f) => f.detail)).toEqual([]);
  });

  it('does not ask the short leg for its own window', () => {
    const found = analysis.violations.filter((v) => v.rule === 'room.daylight');
    expect(found.map((f) => f.detail)).toEqual([]);
  });

  it('does not call the space too narrow because one leg is', () => {
    const found = analysis.violations.filter((v) => v.rule === 'room.min_dimension');
    expect(found.map((f) => f.detail)).toEqual([]);
  });

  it('passes cleanly, which is what the advice promised', () => {
    const problems = analysis.violations
      .filter((v) => v.severity !== 'info')
      .map((v) => `${v.severity} ${v.rule}: ${v.detail}`);
    expect(problems).toEqual([]);
  });
});

describe('a narrow opening is still a doorway, not an open plan', () => {
  it('leaves the rooms measured separately', () => {
    const plan = emptyPlan('Two rooms');
    runBatch(plan, [
      { op: 'add_room', args: { type: 'living', name: 'Living room', width_mm: 5000, depth_mm: 4000 } },
      { op: 'add_room', args: { type: 'living', name: 'Snug', width_mm: 2400, depth_mm: 2600, against_room: 'Living room', against_side: 'e' } },
      { op: 'add_opening', args: { room: 'Snug', kind: 'door', to_room: 'Living room', width_mm: 900 } },
    ]);
    const snug = findRoom(plan, 'Snug')!;
    expect(spaces(plan).get(snug.id)).toHaveLength(1);
    expect(analyse(plan).violations.some((v) => v.rule === 'room.min_area')).toBe(true);
  });
});

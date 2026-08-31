/**
 * Designing a home from nothing.
 *
 * The most demanding thing anyone will ask this app to do is "design me a flat
 * for a wheelchair user" — an agent placing rooms it has never seen, against
 * walls it has to reason about, and then being judged on whether the result
 * actually passes. This suite plays that conversation through the real
 * operations and holds the outcome to the same rules everything else is held
 * to. If the primitives are awkward to drive, it fails here first.
 */

import { describe, expect, it } from 'vitest';

import { emptyPlan } from '../src/core/samples';
import { analyse } from '../src/core/rules';
import { findRoom } from '../src/core/ops';
import { runBatch } from '../src/mcp/operations';
import type { Plan } from '../src/core/types';

/** Applies a sequence and fails loudly, quoting the step, if any of it refuses. */
function build(plan: Plan, steps: { op: string; args: Record<string, unknown> }[]): void {
  const result = runBatch(plan, steps);
  if (!result.ok) throw new Error(`${result.error} — ${result.hint}`);
}

describe('an agent designs a one-bedroom flat for a wheelchair user', () => {
  const plan = emptyPlan('Designed from scratch');

  it('lays out the rooms against each other', () => {
    build(plan, [
      { op: 'add_room', args: { type: 'hall', name: 'Hall', width_mm: 7600, depth_mm: 1600 } },
      {
        op: 'add_room',
        args: { type: 'living', name: 'Living room', width_mm: 4400, depth_mm: 4400, against_room: 'Hall', against_side: 'n' },
      },
      {
        op: 'add_room',
        args: { type: 'kitchen', name: 'Kitchen', width_mm: 3200, depth_mm: 4400, against_room: 'Hall', against_side: 'n', align_mm: 4400 },
      },
      {
        op: 'add_room',
        args: { type: 'bedroom', name: 'Bedroom', width_mm: 4400, depth_mm: 3800, against_room: 'Hall', against_side: 's' },
      },
      {
        op: 'add_room',
        args: { type: 'bathroom', name: 'Wet room', width_mm: 3200, depth_mm: 3800, against_room: 'Hall', against_side: 's', align_mm: 4400 },
      },
    ]);
    expect(plan.rooms).toHaveLength(5);
    // Everything meets edge to edge; nothing overlaps.
    expect(analyse(plan).violations.some((v) => v.rule === 'room.overlap')).toBe(false);
  });

  it('cuts a front door and connects every room to the hall', () => {
    build(plan, [
      { op: 'add_opening', args: { room: 'Hall', kind: 'door', side: 'w', exterior: true, width_mm: 1000 } },
      { op: 'add_opening', args: { room: 'Living room', kind: 'archway', to_room: 'Hall', width_mm: 1800 } },
      { op: 'add_opening', args: { room: 'Kitchen', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
      { op: 'add_opening', args: { room: 'Bedroom', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
      { op: 'add_opening', args: { room: 'Wet room', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
    ]);
    const rules = analyse(plan).violations.map((v) => v.rule);
    expect(rules).not.toContain('room.no_door');
    expect(rules).not.toContain('plan.no_entry');
  });

  it('adds daylight where the rules ask for it', () => {
    build(plan, [
      { op: 'add_opening', args: { room: 'Living room', kind: 'window', exterior: true, side: 'n', width_mm: 2400 } },
      { op: 'add_opening', args: { room: 'Kitchen', kind: 'window', exterior: true, side: 'n', width_mm: 1600 } },
      { op: 'add_opening', args: { room: 'Bedroom', kind: 'window', exterior: true, side: 's', width_mm: 2400 } },
    ]);
    const rules = analyse(plan).violations.map((v) => v.rule);
    expect(rules).not.toContain('room.daylight');
    expect(rules).not.toContain('bedroom.egress');
  });

  it('furnishes every room without breaking anything', () => {
    for (const room of ['Living room', 'Kitchen', 'Bedroom', 'Wet room']) {
      build(plan, [{ op: 'furnish_room', args: { room } }]);
    }
    expect(plan.furniture.length).toBeGreaterThan(8);
  });

  it('produces a home that passes every rule', () => {
    const analysis = analyse(plan);
    const problems = analysis.violations
      .filter((v) => v.severity !== 'info')
      .map((v) => `${v.severity} ${v.rule}: ${v.title} — ${v.detail}`);
    expect(problems).toEqual([]);
    expect(analysis.stats.score).toBe(100);
  });

  it('is reachable in a wheelchair, room by room', () => {
    const analysis = analyse(plan);
    for (const room of analysis.rooms) {
      expect(room.reachRatio, `${room.name} is only ${room.reachRatio} reachable`).toBeGreaterThan(0.6);
    }
    expect(analysis.stats.reachableRatio).toBeGreaterThan(0.85);
  });

  it('leaves a turning circle in every room that needs one', () => {
    for (const name of ['Living room', 'Kitchen', 'Bedroom', 'Wet room']) {
      const room = analyse(plan).rooms.find((r) => r.name === name)!;
      expect(room.turningCircleMm, `${name}`).toBeGreaterThanOrEqual(1500);
    }
  });

  it('is still the plan the agent asked for', () => {
    expect(findRoom(plan, 'Wet room')?.type).toBe('bathroom');
    expect(plan.rooms.map((r) => r.name).sort()).toEqual(
      ['Bedroom', 'Hall', 'Kitchen', 'Living room', 'Wet room'],
    );
  });
});

import { describe, expect, it } from 'vitest';

import { applyFix } from '../src/core/fixes';
import {
  addOpening,
  addRoom,
  findRoom,
  setOpeningWidth,
} from '../src/core/ops';
import { analyse } from '../src/core/rules';
import { starterPlan } from '../src/core/samples';
import { runBatch } from '../src/mcp/operations';

describe('the starter flat', () => {
  const analysis = analyse(starterPlan());

  it('fails on exactly the two things it is designed to fail on', () => {
    const errors = analysis.violations.filter((v) => v.severity === 'error');
    expect(errors.map((e) => e.rule).sort()).toEqual(['access.unreachable', 'door.clear_width']);
  });

  it('measures the undersized bathroom door at 760 mm', () => {
    const finding = analysis.violations.find((v) => v.rule === 'door.clear_width')!;
    expect(finding.measured).toBe(760);
    expect(finding.required).toBe(815);
  });

  it('blames the bathroom door for the bathroom being cut off', () => {
    const finding = analysis.violations.find((v) => v.rule === 'access.unreachable')!;
    expect(finding.detail).toContain('door between Bathroom and Hall');
    // The finding points at the opening, so a fix can target it directly.
    expect(finding.entities.length).toBeGreaterThan(1);
  });

  it('hands every finding a measurement and a next step', () => {
    for (const v of analysis.violations) {
      expect(v.fix, `${v.rule} has no fix`).toBeTruthy();
      expect(v.title.length).toBeGreaterThan(4);
    }
  });
});

describe('repairing the flat', () => {
  it('clears both errors by widening one door', () => {
    const plan = starterPlan();
    const before = analyse(plan);
    const door = before.violations.find((v) => v.rule === 'door.clear_width')!;
    const result = setOpeningWidth(plan, door.entities[0]!, 900);
    expect(result.ok).toBe(true);

    const after = analyse(plan);
    expect(after.stats.errorCount).toBe(0);
    expect(after.stats.score).toBeGreaterThan(before.stats.score);
    expect(after.stats.reachableRatio).toBeGreaterThan(before.stats.reachableRatio);
  });

  it('reaches the same place through fix_violation', () => {
    const plan = starterPlan();
    const finding = analyse(plan).violations.find((v) => v.rule === 'access.unreachable')!;
    const outcome = applyFix(plan, finding);
    expect(outcome.applied).toBe(true);
    expect(analyse(plan).stats.errorCount).toBe(0);
  });
});

describe('rule coverage', () => {
  it('flags a room with no way in', () => {
    const plan = starterPlan();
    plan.openings = plan.openings.filter((o) => o.roomId !== findRoom(plan, 'Study')!.id);
    const found = analyse(plan).violations.some((v) => v.rule === 'room.no_door');
    expect(found).toBe(true);
  });

  it('flags a home with no front door', () => {
    const plan = starterPlan();
    plan.openings = plan.openings.filter((o) => o.kind !== 'door' || o.roomId !== plan.rooms[3]!.id);
    const found = analyse(plan).violations.some((v) => v.rule === 'plan.no_entry');
    expect(found).toBe(true);
  });

  it('flags a bedroom with no escape window', () => {
    const plan = starterPlan();
    const bed = findRoom(plan, 'Main bedroom')!;
    plan.openings = plan.openings.filter((o) => !(o.kind === 'window' && o.roomId === bed.id));
    const found = analyse(plan).violations.some((v) => v.rule === 'bedroom.egress');
    expect(found).toBe(true);
  });

  it('flags rooms that intersect rather than touch', () => {
    const plan = starterPlan();
    plan.rooms[1]!.x -= 500;
    const found = analyse(plan).violations.some((v) => v.rule === 'room.overlap');
    expect(found).toBe(true);
  });
});

describe('operations refuse the impossible, with an explanation', () => {
  it('will not overlap an existing room', () => {
    const plan = starterPlan();
    const result = addRoom(plan, { type: 'storage', widthMm: 2000, depthMm: 2000, xMm: 0, yMm: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('overlaps');
      expect(result.hint).toBeTruthy();
    }
  });

  it('says how wide an opening could have been', () => {
    const plan = starterPlan();
    const result = addOpening(plan, { roomRef: 'Hall', side: 'n', kind: 'door', widthMm: 12000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toMatch(/widest that fits/i);
  });

  it('will not connect two rooms that do not share a wall', () => {
    const plan = starterPlan();
    const result = addOpening(plan, {
      roomRef: 'Living room',
      side: 'n',
      kind: 'door',
      toRoom: 'Study',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('do not share a wall');
  });

  it('resolves rooms by partial name and by type', () => {
    const plan = starterPlan();
    expect(findRoom(plan, 'bath')?.name).toBe('Bathroom');
    expect(findRoom(plan, 'kitchen')?.type).toBe('kitchen');
    expect(findRoom(plan, 'nothing here')).toBeNull();
  });
});

describe('batches are all or nothing', () => {
  it('applies every step when they all succeed', () => {
    const plan = starterPlan();
    const result = runBatch(plan, [
      { op: 'fix_violation', args: { rule: 'door.clear_width' } },
      { op: 'edit_room', args: { room: 'Study', name: 'Home office' } },
    ]);
    expect(result.ok).toBe(true);
    expect(findRoom(plan, 'Home office')).not.toBeNull();
  });

  it('reports which step failed and leaves the caller to discard the draft', () => {
    const plan = starterPlan();
    const result = runBatch(plan, [
      { op: 'edit_room', args: { room: 'Study', name: 'Home office' } },
      { op: 'edit_room', args: { room: 'No such room', name: 'Nope' } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Step 2');
      expect(result.hint).toContain('all or nothing');
    }
  });

  it('refuses an operation it does not have', () => {
    const result = runBatch(starterPlan(), [{ op: 'demolish', args: {} }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Available operations');
  });
});

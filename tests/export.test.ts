import { describe, expect, it } from 'vitest';

import { decodePlan, encodePlan } from '../src/core/share';
import { planToSchedule, planToSvg } from '../src/core/svg';
import { analyse } from '../src/core/rules';
import { starterPlan } from '../src/core/samples';

describe('share links', () => {
  it('round-trips a plan through the URL fragment', async () => {
    const plan = starterPlan();
    plan.name = 'Round trip';
    const token = await encodePlan(plan);
    const back = await decodePlan(token);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('Round trip');
    expect(back!.rooms).toHaveLength(plan.rooms.length);
    expect(back!.furniture).toHaveLength(plan.furniture.length);
  });

  it('compresses rather than just encoding', async () => {
    const plan = starterPlan();
    const token = await encodePlan(plan);
    expect(token.startsWith('z')).toBe(true);
    expect(token.length).toBeLessThan(JSON.stringify(plan).length / 2);
  });

  it('returns null for a token that is not a plan', async () => {
    expect(await decodePlan('znot-a-real-token')).toBeNull();
  });
});

describe('svg export', () => {
  const plan = starterPlan();
  const svg = planToSvg(plan, { analysis: analyse(plan), annotate: true });

  it('is a self-contained svg document', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox=');
  });

  it('names every room', () => {
    for (const room of plan.rooms) expect(svg).toContain(room.name.toUpperCase());
  });

  it('escapes text rather than injecting it', () => {
    const nasty = starterPlan();
    nasty.rooms[0]!.name = 'A & B <script>';
    const out = planToSvg(nasty);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&amp;');
  });
});

describe('room schedule', () => {
  it('lists every room with its area', () => {
    const plan = starterPlan();
    const md = planToSchedule(plan, analyse(plan));
    for (const room of plan.rooms) expect(md).toContain(room.name);
    expect(md).toContain('| Room | Type | Area m²');
  });
});

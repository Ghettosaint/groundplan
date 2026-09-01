/**
 * Getting a real home into the app.
 *
 * Drawing from scratch is fine for a demo. The thing people actually want is to
 * point at the flat they are looking at — which arrives as a picture, with room
 * names and areas printed on it. These two tools are the path from that picture
 * to a plan you can trust: one hands the model the image, the other tells it
 * whether what it drew matches the numbers on the original.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { starterPlan } from '../src/core/samples';
import { store } from '../src/core/store';
import { buildTools } from '../src/mcp/tools';

beforeEach(() => {
  store.plan = starterPlan();
  store.selection = null;
  store.mode = 'design';
  store.proposal = null;
  store.requireApproval = false;
  store.underlay = null;
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = buildTools().find((t) => t.name === name);
  if (!tool) throw new Error(`No tool called ${name}`);
  const result = await tool.execute(args);
  const text = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown>, blocks: result.content };
}

describe('handing the picture over', () => {
  it('says plainly that only a person can add one', async () => {
    const { isError, body } = await call('get_tracing_image');
    expect(isError).toBe(true);
    expect(String(body.hint)).toMatch(/drop|paste/i);
    expect(String(body.hint)).toMatch(/cannot load a file/i);
  });
});

describe('checking a traced plan against the printed numbers', () => {
  /** The starter flat's real areas, as if read off a drawing. */
  const truth = [
    { room: 'Living room', area_m2: 16.56 },
    { room: 'Kitchen', area_m2: 10.08 },
    { room: 'Bathroom', area_m2: 9.36 },
    { room: 'Hall', area_m2: 12.0 },
  ];

  it('confirms a faithful tracing', async () => {
    const { body } = await call('check_against_source', { rooms: truth });
    expect(String(body.summary)).toMatch(/matches the source/i);
    for (const row of body.rooms as { verdict: string }[]) expect(row.verdict).toBe('matches');
  });

  it('says which room is wrong, by how much, and in which direction', async () => {
    const { body } = await call('check_against_source', {
      rooms: [{ room: 'Kitchen', area_m2: 14 }],
    });
    const row = (body.rooms as { source_room: string; out_by_percent: number; verdict: string }[])[0]!;
    expect(row.source_room).toBe('Kitchen');
    expect(row.out_by_percent).toBeLessThan(-20);
    expect(row.verdict).toMatch(/too small/);
    expect(String(body.hint)).toMatch(/edit_room/);
  });

  it('flags a room the source names but the drawing does not have yet', async () => {
    const { body } = await call('check_against_source', {
      rooms: [{ room: 'Балкон', area_m2: 7.42 }],
    });
    expect((body.rooms as { verdict: string }[])[0]!.verdict).toBe('not drawn yet');
  });

  it('lists rooms that were drawn but not in the source', async () => {
    const { body } = await call('check_against_source', { rooms: truth });
    expect(body.rooms_drawn_but_not_listed).toContain('Study');
  });

  it('spots that rooms are still missing when the total falls short', async () => {
    // The starter flat is about 74 m²; claim the drawing says 90 and the four
    // named rooms are all correct — the only explanation is untraced rooms.
    const { body } = await call('check_against_source', { rooms: truth, total_area_m2: 90 });
    expect(body.source_total_m2).toBe(90);
    expect(String(body.summary)).toMatch(/under by/i);
    expect(String(body.summary)).toMatch(/not traced yet/i);
    expect(String(body.hint)).toMatch(/still missing/i);
  });

  it('spots that something extra has been drawn when the total overshoots', async () => {
    const { body } = await call('check_against_source', { rooms: truth, total_area_m2: 60 });
    expect(String(body.summary)).toMatch(/over by/i);
    expect(String(body.summary)).toMatch(/not on the original/i);
  });

  it('refuses when given nothing to compare against', async () => {
    const { isError, body } = await call('check_against_source', {});
    expect(isError).toBe(true);
    expect(String(body.hint)).toMatch(/total_area_m2/);
  });
});

/**
 * The tool surface, exercised the way an agent would exercise it.
 *
 * Two things are being checked. First, that every tool actually works — valid
 * arguments change the plan, invalid ones come back as a clean explanation
 * rather than an exception. Second, that the tools are *well formed*: an agent
 * only ever sees the description and the schema, so those are part of the
 * product and are tested like it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { starterPlan } from '../src/core/samples';
import { store } from '../src/core/store';
import { buildTools } from '../src/mcp/tools';
import type { ToolSpec } from '../src/mcp/runtime';

function reset(): void {
  store.plan = starterPlan();
  store.selection = null;
  store.mode = 'design';
  store.proposal = null;
  store.activity = [];
  store.requireApproval = false;
  store.agentBusy = null;
}

function tool(name: string): ToolSpec {
  const found = buildTools().find((t) => t.name === name);
  if (!found) throw new Error(`No tool called ${name}. Have: ${buildTools().map((t) => t.name).join(', ')}`);
  return found;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await tool(name).execute(args);
  const text = result.content.map((c) => c.text).join('');
  return { raw: result, body: JSON.parse(text) as Record<string, unknown> };
}

/**
 * Destructive tools stop at the consent gate whatever the approval setting
 * says, so a test that calls one has to answer for the absent human.
 */
async function callAndAnswer(name: string, args: Record<string, unknown>, approve: boolean) {
  const pending = tool(name).execute(args);
  await new Promise((r) => setTimeout(r, 0));
  if (!store.proposal) throw new Error(`${name} did not ask for approval`);
  store.proposal.resolve(approve);
  const result = await pending;
  const text = result.content.map((c) => c.text).join('');
  return { raw: result, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(reset);

describe('every tool is well formed', () => {
  const tools = (() => {
    reset();
    store.selection = { kind: 'room', id: starterPlan().rooms[0]!.id };
    const all = buildTools();
    store.selection = null;
    return all;
  })();

  it('has a unique name in snake_case', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('describes what it does in enough words to choose it', () => {
    for (const t of tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(60);
      expect(t.description.trim().endsWith('.'), `${t.name} description ends mid-sentence`).toBe(true);
    }
  });

  it('closes its input schema, as the WebMCP guidance asks', () => {
    for (const t of tools) {
      const schema = t.inputSchema as {
        type?: string;
        additionalProperties?: boolean;
        properties?: Record<string, { description?: string; type?: string }>;
        required?: string[];
      };
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, `${t.name} allows unknown properties`).toBe(false);
      for (const key of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {}), `${t.name}.${key} is required but undeclared`).toContain(key);
      }
    }
  });

  it('marks read-only tools as read-only and destructive ones as destructive', () => {
    const readOnly = ['get_plan', 'check_plan', 'analyse_access', 'measure', 'list_catalog', 'get_selection', 'get_activity', 'export_plan'];
    const destructive = ['delete_entity', 'clear_room', 'load_sample'];
    for (const name of readOnly) expect(tool(name).annotations?.readOnlyHint, name).toBe(true);
    for (const name of destructive) expect(tool(name).annotations?.destructiveHint, name).toBe(true);
  });

  it('never marks a mutating tool read-only', () => {
    for (const t of tools) {
      const mutating = ['add_', 'edit_', 'delete_', 'clear_', 'set_standards', 'furnish_', 'apply_batch', 'fix_', 'undo_', 'load_'].some(
        (p) => t.name.startsWith(p),
      );
      if (mutating) expect(t.annotations?.readOnlyHint, t.name).not.toBe(true);
    }
  });
});

describe('read tools answer', () => {
  const names = ['get_plan', 'check_plan', 'analyse_access', 'list_catalog', 'get_selection', 'get_activity'];

  for (const name of names) {
    it(`${name} returns a summary and no error`, async () => {
      const { raw, body } = await call(name);
      expect(raw.isError).toBeFalsy();
      expect(body.ok).toBe(true);
      expect(typeof body.summary).toBe('string');
      expect((body.summary as string).length).toBeGreaterThan(4);
    });
  }

  it('measure resolves rooms, furniture and literal points', async () => {
    const a = await call('measure', { from: 'Living room', to: 'Bathroom' });
    expect(a.body.distance_mm).toBeGreaterThan(0);
    const b = await call('measure', { from: '0,0', to: '3000,4000' });
    expect(b.body.distance_mm).toBe(5000);
  });

  it('measure explains itself when a reference is nonsense', async () => {
    const { raw, body } = await call('measure', { from: 'the moon', to: 'Bathroom' });
    expect(raw.isError).toBe(true);
    expect(String(body.hint)).toContain('Rooms in this plan');
  });

  it('export_plan produces a schedule and an svg', async () => {
    const schedule = await call('export_plan', { format: 'schedule' });
    expect(String(schedule.body.markdown)).toContain('| Room |');
    const svg = await call('export_plan', { format: 'svg' });
    expect(String(svg.body.svg).startsWith('<svg')).toBe(true);
  });
});

describe('write tools change the plan', () => {
  it('add_room places a room against a neighbour', async () => {
    const before = store.plan.rooms.length;
    const { body } = await call('add_room', {
      type: 'utility',
      width_mm: 2000,
      depth_mm: 2000,
      against_room: 'Study',
      against_side: 'e',
    });
    expect(body.ok).toBe(true);
    expect(store.plan.rooms.length).toBe(before + 1);
  });

  it('edit_room renames and resizes', async () => {
    await call('edit_room', { room: 'Study', name: 'Home office' });
    expect(store.plan.rooms.some((r) => r.name === 'Home office')).toBe(true);
  });

  it('add_opening cuts a window into an external wall', async () => {
    const before = store.plan.openings.length;
    await call('add_opening', { room: 'Study', kind: 'window', exterior: true, side: 'e', width_mm: 1000 });
    expect(store.plan.openings.length).toBe(before + 1);
  });

  it('edit_opening widens a door and clears the finding', async () => {
    const finding = (await call('check_plan', { rule: 'door.clear_width' })).body.findings as {
      entity_ids: string[];
    }[];
    await call('edit_opening', { opening_id: finding[0]!.entity_ids[0], width_mm: 1000 });
    const after = (await call('check_plan', { severity: 'error' })).body.findings as unknown[];
    expect(after).toHaveLength(0);
  });

  it('add_furniture and edit_furniture move real objects', async () => {
    await call('add_furniture', { type: 'armchair', room: 'Study' });
    const item = store.plan.furniture.at(-1)!;
    await call('edit_furniture', { item: item.id, dx_mm: 100, rotation_deg: 180 });
    expect(store.plan.furniture.find((f) => f.id === item.id)!.rot).toBe(180);
  });

  it('furnish_room fills an empty room', async () => {
    await call('add_room', { type: 'bedroom', width_mm: 3600, depth_mm: 3600, against_room: 'Study', against_side: 'e' });
    const before = store.plan.furniture.length;
    const { body } = await call('furnish_room', { room: 'Bedroom' });
    expect(body.ok).toBe(true);
    expect(store.plan.furniture.length).toBeGreaterThan(before);
  });

  it('delete_entity removes a room and everything in it, once approved', async () => {
    const study = store.plan.rooms.find((r) => r.name === 'Study')!;
    await callAndAnswer('delete_entity', { kind: 'room', reference: 'Study' }, true);
    expect(store.plan.rooms.some((r) => r.id === study.id)).toBe(false);
    expect(store.plan.openings.some((o) => o.roomId === study.id)).toBe(false);
  });

  it('delete_entity changes nothing when the person says no', async () => {
    const before = JSON.stringify(store.plan);
    const { body } = await callAndAnswer('delete_entity', { kind: 'room', reference: 'Study' }, false);
    expect(body.ok).toBe(false);
    expect(body.approved).toBe(false);
    expect(JSON.stringify(store.plan)).toBe(before);
  });

  it('asks even when the approval switch is off, if the change is destructive', async () => {
    store.requireApproval = false;
    const pending = tool('clear_room').execute({ room: 'Kitchen' });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.proposal, 'a destructive tool went through without asking').not.toBeNull();
    store.proposal!.resolve(false);
    await pending;
  });

  it('set_standards re-measures against a different body', async () => {
    const before = (await call('analyse_access')).body.tested_diameter_mm;
    await call('set_standards', { mobility_diameter_mm: 700 });
    const after = (await call('analyse_access')).body.tested_diameter_mm;
    expect(before).toBe(900);
    expect(after).toBe(700);
  });

  it('undo_last rolls a change back', async () => {
    await call('edit_room', { room: 'Study', name: 'Changed' });
    await call('undo_last');
    expect(store.plan.rooms.some((r) => r.name === 'Study')).toBe(true);
  });

  it('every mutating tool reports what it did to the findings', async () => {
    const { body } = await call('edit_opening', {
      opening_id: store.plan.openings.find((o) => o.width === 800)!.id,
      width_mm: 1000,
    });
    const issues = body.issues as { resolved: string[]; introduced: string[]; before: number; after: number };
    expect(issues.resolved.length).toBeGreaterThan(0);
    expect(issues.after).toBeLessThan(issues.before);
  });
});

describe('bad arguments come back as prose, never as an exception', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['add_room', { type: 'dungeon', width_mm: 3000, depth_mm: 3000 }],
    ['add_room', { type: 'bedroom', width_mm: 10, depth_mm: 10 }],
    ['edit_room', { room: 'No such room', name: 'x' }],
    ['edit_room', { room: 'Study' }],
    ['add_opening', { room: 'Study', kind: 'door', width_mm: 99999 }],
    ['edit_opening', { opening_id: 'nope', width_mm: 900 }],
    ['add_furniture', { type: 'hovercraft', room: 'Study' }],
    ['add_furniture', { type: 'bed_king', room: 'Nowhere' }],
    ['edit_furniture', { item: 'nothing', dx_mm: 10 }],
    ['furnish_room', { room: 'Nowhere' }],
    ['delete_entity', { kind: 'spaceship', reference: 'x' }],
    ['delete_entity', { kind: 'room', reference: 'Nowhere' }],
    ['clear_room', { room: 'Nowhere' }],
    ['set_standards', { mobility_diameter_mm: 5 }],
    ['fix_violation', { rule: 'nonsense.rule' }],
    ['apply_batch', { intent: 'x', operations: [] }],
    ['apply_batch', { intent: 'x', operations: [{ op: 'demolish', args: {} }] }],
    ['highlight', { targets: ['nothing at all'] }],
    ['set_view', {}],
    ['measure', { from: 'x', to: 'y' }],
  ];

  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args)}`, async () => {
      const { raw, body } = await call(name, args);
      expect(raw.isError, `${name} should have refused`).toBe(true);
      expect(typeof body.summary).toBe('string');
      expect((body.summary as string).length).toBeGreaterThan(8);
    });
  }

  it('leaves the plan untouched when it refuses', async () => {
    const before = JSON.stringify(store.plan);
    for (const [name, args] of cases) await call(name, args);
    expect(JSON.stringify(store.plan)).toBe(before);
  });
});

describe('the tool set follows the state of the page', () => {
  const names = () => buildTools().map((t) => t.name);

  it('offers everything while editing', () => {
    expect(names()).toContain('add_room');
    expect(names()).toContain('fix_violation');
  });

  it('withdraws every write in review mode', () => {
    store.mode = 'review';
    const list = names();
    for (const name of ['add_room', 'edit_room', 'delete_entity', 'apply_batch', 'fix_violation', 'undo_last']) {
      expect(list, name).not.toContain(name);
    }
    expect(list).toContain('check_plan');
  });

  it('adds edit_selection only when something is selected', () => {
    expect(names()).not.toContain('edit_selection');
    store.selection = { kind: 'room', id: store.plan.rooms[0]!.id };
    expect(names()).toContain('edit_selection');
  });

  it('drops fix_violation when there is nothing to fix', async () => {
    await callAndAnswer('load_sample', { which: 'accessible' }, true);
    expect(names()).not.toContain('fix_violation');
  });

  it('withdraws writes while a proposal waits, bar the one that raised it', () => {
    store.proposal = {
      id: 'p1',
      title: 'x',
      summary: 'x',
      tool: 'edit_room',
      next: store.plan,
      changes: [],
      created: Date.now(),
      resolve: () => {},
    };
    const list = names();
    expect(list).toContain('edit_room');
    expect(list).toContain('check_proposal');
    expect(list).not.toContain('add_room');
    expect(list).not.toContain('delete_entity');
  });
});

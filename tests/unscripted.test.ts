/**
 * Requests nobody planned for.
 *
 * A demo only has to survive the script. A real conversation asks for L-shaped
 * rooms, a second storey, ceiling heights, a 3D tour and "just email it to my
 * architect" — and the honest answer to most of those is no. What must never
 * happen is a silent nearly-right answer: an agent writing `{ shape: "L" }`,
 * getting a rectangle, and telling the person it is done.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { starterPlan } from '../src/core/samples';
import { store } from '../src/core/store';
import { buildTools } from '../src/mcp/tools';

function reset(): void {
  store.plan = starterPlan();
  store.selection = null;
  store.mode = 'design';
  store.proposal = null;
  store.activity = [];
  store.requireApproval = false;
  store.agentBusy = null;
  store.underlay = null;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = buildTools().find((t) => t.name === name);
  if (!tool) throw new Error(`No tool called ${name}`);
  const result = await tool.execute(args);
  const body = JSON.parse(result.content.map((c) => c.text).join('')) as Record<string, unknown>;
  return { isError: result.isError === true, body, text: JSON.stringify(body) };
}

beforeEach(reset);

describe('arguments the app cannot honour are refused, not quietly dropped', () => {
  it('does not pretend to draw an L-shaped room', async () => {
    const before = JSON.stringify(store.plan);
    const { isError, text } = await call('add_room', {
      type: 'living',
      width_mm: 4000,
      depth_mm: 3000,
      shape: 'L',
    });
    expect(isError).toBe(true);
    expect(text).toContain('shape');
    expect(text).toMatch(/rectangle/i);
    expect(text).toMatch(/archway/i);
    expect(JSON.stringify(store.plan), 'the room was added anyway').toBe(before);
  });

  it('will not take a length written as prose', async () => {
    const { isError, text } = await call('add_room', {
      type: 'living',
      width_mm: 'three metres',
      depth_mm: 3000,
    });
    expect(isError).toBe(true);
    expect(text).toContain('width_mm');
    expect(text).toMatch(/millimetres/i);
  });

  it('says which required argument is missing rather than inventing one', async () => {
    const { isError, text } = await call('add_room', { type: 'bedroom' });
    expect(isError).toBe(true);
    expect(text).toContain('width_mm');
    expect(store.plan.rooms).toHaveLength(starterPlan().rooms.length);
  });

  it('lists the values it will accept for an enum', async () => {
    const { isError, text } = await call('add_room', { type: 'ballroom', width_mm: 3000, depth_mm: 3000 });
    expect(isError).toBe(true);
    expect(text).toMatch(/bedroom/);
    expect(text).toMatch(/kitchen/);
  });

  it('refuses a 45-degree rotation and says what turns are possible', async () => {
    const { isError, text } = await call('edit_furniture', { item: 'Double bed', rotation_deg: 45 });
    expect(isError).toBe(true);
    expect(text).toContain('rotation_deg');
    expect(text).toContain('90');
  });

  const misconceptions: [string, Record<string, unknown>, RegExp][] = [
    ['a second storey', { type: 'bedroom', width_mm: 3000, depth_mm: 3000, floor: 2 }, /one storey/i],
    ['a ceiling height', { type: 'living', width_mm: 3000, depth_mm: 3000, ceiling_height: 2400 }, /Only the plan is modelled/i],
    ['a wall colour', { type: 'living', width_mm: 3000, depth_mm: 3000, colour: 'sage' }, /Finishes are not modelled/i],
    ['a photograph', { type: 'living', width_mm: 3000, depth_mm: 3000, photo: 'x.png' }, /dropping or pasting/i],
    ['a build cost', { type: 'living', width_mm: 3000, depth_mm: 3000, cost: 1000 }, /Costs are not modelled/i],
    ['a 3D render', { type: 'living', width_mm: 3000, depth_mm: 3000, render: '3d' }, /show_route/i],
    ['a compass bearing', { type: 'living', width_mm: 3000, depth_mm: 3000, orientation: 'north' }, /no compass orientation/i],
  ];

  for (const [what, args, expected] of misconceptions) {
    it(`explains why it cannot model ${what}`, async () => {
      const { isError, text } = await call('add_room', args);
      expect(isError).toBe(true);
      expect(text).toMatch(expected);
    });
  }
});

describe('batched steps are held to the same standard', () => {
  it('names the offending step and applies none of it', async () => {
    const before = JSON.stringify(store.plan);
    const { isError, text } = await call('apply_batch', {
      intent: 'Add two rooms',
      operations: [
        { op: 'add_room', args: { type: 'storage', width_mm: 1500, depth_mm: 1500, against_room: 'Study', against_side: 'e' } },
        { op: 'add_room', args: { type: 'bedroom', width_mm: 3000, depth_mm: 3000, shape: 'L' } },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toContain('Step 2');
    expect(text).toMatch(/rectangle/i);
    expect(text).toMatch(/all or nothing/i);
    expect(JSON.stringify(store.plan)).toBe(before);
  });
});

describe('the agent can find out what is possible before trying', () => {
  it('get_capabilities lists the limits with a reason and an alternative', async () => {
    const { body } = await call('get_capabilities');
    const cannot = body.cannot_do as { asked_for: string; why: string; instead: string }[];
    expect(cannot.length).toBeGreaterThan(5);
    for (const entry of cannot) {
      expect(entry.why.length, entry.asked_for).toBeGreaterThan(20);
      expect(entry.instead.length, entry.asked_for).toBeGreaterThan(20);
    }
    expect(JSON.stringify(cannot)).toMatch(/L-shaped/);
    expect(JSON.stringify(cannot)).toMatch(/3D/);
    expect(JSON.stringify(cannot)).toMatch(/storey/);
  });

  it('reports the state that changes what is allowed', async () => {
    const { body } = await call('get_capabilities');
    const now = body.right_now as Record<string, unknown>;
    expect(now.editing_allowed).toBe(true);
    expect(now.approval_required).toBe(false);
    expect(Array.isArray(now.tools_available)).toBe(true);

    store.mode = 'review';
    const locked = await call('get_capabilities');
    expect((locked.body.right_now as Record<string, unknown>).editing_allowed).toBe(false);
  });

  it('never claims a control the person keeps to themselves', async () => {
    const names = buildTools().map((t) => t.name);
    for (const forbidden of ['set_approval', 'disable_approval', 'set_mode', 'leave_review']) {
      expect(names).not.toContain(forbidden);
    }
    const { body } = await call('get_capabilities');
    expect(JSON.stringify(body.cannot_do)).toMatch(/approval gate/i);
  });
});

describe('everything the interface offers, an agent can reach', () => {
  const names = () => {
    reset();
    store.selection = { kind: 'room', id: store.plan.rooms[0]!.id };
    store.underlay = {
      src: 'data:,',
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      opacity: 0.5,
      locked: false,
      label: 'test',
    };
    const list = buildTools().map((t) => t.name);
    reset();
    return list;
  };

  const parity: [string, string][] = [
    ['rename the plan', 'edit_plan'],
    ['change the standards', 'edit_plan'],
    ['undo and redo', 'undo'],
    ['add a room', 'add_room'],
    ['resize, move, rename or retype a room', 'edit_room'],
    ['cut a door or window', 'add_opening'],
    ['widen, slide or reverse an opening', 'edit_opening'],
    ['place furniture', 'add_furniture'],
    ['move or rotate furniture', 'edit_furniture'],
    ['furnish a whole room', 'furnish_room'],
    ['empty a room', 'clear_room'],
    ['delete anything', 'delete_entity'],
    ['repair a finding', 'fix_violation'],
    ['edit what is selected', 'edit_selection'],
    ['open a sample or a blank page', 'load_sample'],
    ['export and share', 'export_plan'],
    ['toggle the overlays, fit the view, select something', 'set_view'],
    ['point at something', 'highlight'],
    ['play a route', 'show_route'],
    ['scale or lock the tracing image', 'edit_underlay'],
    ['read the plan', 'get_plan'],
    ['run the rules', 'check_plan'],
    ['measure', 'measure'],
    ['analyse access', 'analyse_access'],
    ['compare mobility standards', 'compare_standards'],
    ['read the shared history', 'get_activity'],
    ['see what the user selected', 'get_selection'],
    ['list the catalogue', 'list_catalog'],
    ['ask what is possible', 'get_capabilities'],
    ['batch a whole piece of work', 'apply_batch'],
  ];

  const registered = names();
  for (const [capability, tool] of parity) {
    it(`${capability} → ${tool}`, () => {
      expect(registered).toContain(tool);
    });
  }
});

describe('references resolve to the thing that was named', () => {
  it('an opening id is not swallowed by a furniture label it happens to sit inside', async () => {
    // The bathroom door's id is "ob", which is also a substring of "Oven / hob".
    // Resolving kind by kind used to hand back the oven.
    const door = store.plan.openings.find((o) => o.width === 800)!;
    expect(door.id).toBe('ob');
    const { body } = await call('measure', { from: 'Bathroom', to: door.id });
    expect(String(body.summary)).toContain('door');
    expect(String(body.summary)).not.toContain('Oven');
  });

  it('two letters are not enough to match a label by substring', async () => {
    // "ov" is inside "Oven / hob" and is nobody's id, so it should match nothing.
    const { isError, text } = await call('measure', { from: 'Bathroom', to: 'ov' });
    expect(isError).toBe(true);
    expect(text).toMatch(/Could not resolve/i);
  });

  it('selecting by id picks the entity with that id, whatever kind it is', async () => {
    const door = store.plan.openings.find((o) => o.width === 800)!;
    await call('set_view', { select: door.id });
    expect(store.selection).toEqual({ kind: 'opening', id: door.id });

    const item = store.plan.furniture[0]!;
    await call('set_view', { select: item.id });
    expect(store.selection).toEqual({ kind: 'furniture', id: item.id });
  });
});

describe('an empty drawing is never a dead end', () => {
  it('a blank page still offers every way back', async () => {
    // Reached by clearing an example, tracing a picture and then removing it,
    // or asking for a blank page. A reload takes the undo history with it, so
    // "press Ctrl+Z" is not an answer.
    const blank = buildTools().find((t) => t.name === 'load_sample')!;
    const pending = blank.execute({ which: 'blank' });
    await new Promise((r) => setTimeout(r, 0));
    store.proposal?.resolve(true);
    await pending;

    expect(store.plan.rooms).toHaveLength(0);
    expect(store.underlay).toBeNull();
    // The tools that get you out of it are all still registered.
    const names = buildTools().map((t) => t.name);
    for (const escape of ['load_sample', 'add_room', 'get_capabilities']) {
      expect(names).toContain(escape);
    }
  });
});

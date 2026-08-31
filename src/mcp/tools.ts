/**
 * The WebMCP tool surface.
 *
 * Design notes worth knowing before reading on:
 *
 * • Tools speak millimetres and room *names*. An agent should be able to say
 *   "widen the bathroom door" without first learning our id scheme, so every
 *   reference resolves by id, exact name, partial name or room type.
 *
 * • Every mutating tool returns what its change did to the rule findings —
 *   `issues.resolved` and `issues.introduced`. That closes the loop: the agent
 *   sees whether the edit actually helped, in the same round trip.
 *
 * • Failures come back as prose plus a `hint`, never as an exception. A tool
 *   that says "the north wall of the Kitchen is only 2800 mm, the widest
 *   opening that fits is 2600 mm" gets a correct second attempt; one that
 *   throws gets a shrug.
 *
 * • The registered set is dynamic. See `buildTools` at the bottom.
 */

import { CATALOG, ROOM_TYPES, ROOM_TYPE_KEYS } from '../core/catalog';
import { applyFix, findViolation } from '../core/fixes';
import { areaM2, openingNeighbour, rectCentre, roomRect, wallSegments } from '../core/geometry';
import { clearanceAt, doorClearWidth } from '../core/grid';
import {
  addFurniture,
  addOpening,
  addRoom,
  clearRoom,
  deleteFurniture,
  deleteOpening,
  deleteRoom,
  findFurniture,
  findOpening,
  findRoom,
  furnishRoom,
  moveFurniture,
  moveOpening,
  moveRoom,
  renameRoom,
  resizeRoom,
  rotateFurniture,
  setDoorSwing,
  setOpeningWidth,
  setRoomType,
  setSettings,
  roomNames,
  type OpResult,
} from '../core/ops';
import { analyse } from '../core/rules';
import { shellPlan, starterPlan } from '../core/samples';
import { store } from '../core/store';
import type { Plan, RoomType, Side } from '../core/types';
import { describeDelta, issueDelta, requestApproval } from './gate';
import { host, reply, replyError, type ToolContent, type ToolSpec } from './runtime';

// ── Shared schema fragments ──────────────────────────────────────────────────

const SIDE_ENUM = { type: 'string', enum: ['n', 'e', 's', 'w'], description: 'Compass side: n, e, s or w.' };
const ROOM_REF = {
  type: 'string',
  description: 'Room id, exact name, partial name or room type. Case-insensitive.',
};

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

// ── Execution plumbing ───────────────────────────────────────────────────────

function note(tool: string, detail: string): void {
  store.note(tool, 'agent', detail, tool);
}

/** Marks the page busy while a tool runs, so the canvas can show presence. */
async function withPresence<T>(tool: string, run: () => Promise<T> | T): Promise<T> {
  store.agentBusy = tool;
  store.emit();
  try {
    return await run();
  } finally {
    store.agentBusy = null;
    store.lastAgentSeen = Date.now();
    store.emit();
  }
}

type Runner = (draft: Plan) => OpResult<unknown>;

interface MutateOptions {
  /** Skip the approval gate when the user has switched it off. */
  destructive?: boolean;
  title?: string;
  /** Ids to flash on the canvas once the change lands. */
  spotlight?: (draft: Plan) => string[];
}

/**
 * Runs a mutation as a proposal: build the draft, describe it, ask the human if
 * the page is configured to, then commit. Returns a result that always tells
 * the agent whether the plan got better or worse.
 */
async function mutate(tool: string, run: Runner, opts: MutateOptions = {}): Promise<ToolContent> {
  return withPresence(tool, async () => {
    if (store.mode === 'review') {
      return replyError(
        'The plan is in review mode, so edits are switched off at the page.',
        { hint: 'Ask the person to leave review mode, or use the read-only tools.' },
      );
    }

    const before = store.plan;
    const draft = structuredClone(before);
    const res = run(draft);
    if (!res.ok) {
      note(tool, `Rejected: ${res.error}`);
      return replyError(res.error, { hint: res.hint, rooms_in_plan: before.rooms.map((r) => r.name) });
    }

    const changes = describeDelta(before, draft);
    const issues = issueDelta(before, draft);
    const needsApproval = store.requireApproval || opts.destructive === true;

    if (needsApproval) {
      const outcome = await requestApproval({
        title: opts.title ?? res.message,
        summary: res.message,
        changes,
        next: draft,
        tool,
      });
      if (!outcome.approved) {
        note(tool, `Declined: ${outcome.reason}`);
        return reply({
          ok: false,
          approved: false,
          summary: `The change was not applied. ${outcome.reason}`,
          proposed_changes: changes,
          hint: 'Nothing was written. Ask what they would prefer, then propose a different change.',
        });
      }
    }

    store.commitPlan(res.message, 'agent', draft, { tool, detail: changes.join('; ') });
    const spotlight = opts.spotlight?.(store.plan);
    if (spotlight?.length) store.flash(spotlight, res.message);

    const after = analyse(store.plan);
    return reply({
      ok: true,
      approved: needsApproval ? true : undefined,
      summary: res.message,
      changes,
      issues,
      plan_score: after.stats.score,
      remaining_errors: after.stats.errorCount,
      remaining_warnings: after.stats.warningCount,
    });
  });
}

// ── Read-only projections ────────────────────────────────────────────────────

function planForAgent(plan: Plan) {
  const a = analyse(plan);
  return {
    name: plan.name,
    units: 'millimetres; areas in square metres',
    coordinate_system: 'x grows east, y grows south, origin at the plan corner',
    standards: {
      mobility_diameter_mm: plan.settings.mobilityRadius * 2,
      turning_circle_mm: plan.settings.turningCircle,
      min_clear_door_mm: plan.settings.minClearDoor,
      interior_wall_mm: plan.settings.interiorWall,
      exterior_wall_mm: plan.settings.exteriorWall,
    },
    rooms: plan.rooms.map((r) => {
      const stat = a.rooms.find((s) => s.id === r.id);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        x_mm: r.x,
        y_mm: r.y,
        width_mm: r.w,
        depth_mm: r.h,
        area_m2: areaM2(roomRect(r)),
        turning_circle_mm: stat?.turningCircleMm,
        reachable_fraction: stat?.reachRatio,
        neighbours: wallSegments(plan)
          .filter((s) => s.roomId === r.id && s.neighbourId)
          .map((s) => ({
            side: s.side,
            room: plan.rooms.find((x) => x.id === s.neighbourId)?.name,
            shared_wall_mm: s.end - s.start,
          })),
        external_walls: wallSegments(plan)
          .filter((s) => s.roomId === r.id && !s.neighbourId && s.end - s.start > 400)
          .map((s) => ({ side: s.side, length_mm: s.end - s.start })),
      };
    }),
    openings: plan.openings.map((o) => ({
      id: o.id,
      kind: o.kind,
      in_room: plan.rooms.find((r) => r.id === o.roomId)?.name,
      side: o.side,
      offset_mm: o.offset,
      width_mm: o.width,
      swing: o.swing,
      leads_to:
        plan.rooms.find((r) => r.id === openingNeighbour(plan, o))?.name ?? 'outside',
    })),
    furniture: plan.furniture.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      x_mm: f.cx,
      y_mm: f.cy,
      footprint_mm: [f.w, f.h],
      rotation_deg: f.rot,
      clear_floor_needed_mm: f.approach,
    })),
    totals: a.stats,
  };
}

function issuesForAgent(plan: Plan, severity?: string, rule?: string) {
  const a = analyse(plan);
  const name = (id: string) =>
    plan.rooms.find((r) => r.id === id)?.name ??
    plan.furniture.find((f) => f.id === id)?.label ??
    plan.openings.find((o) => o.id === id)?.kind ??
    id;
  return a.violations
    .filter((v) => (severity ? v.severity === severity : true))
    .filter((v) => (rule ? v.rule === rule : true))
    .map((v) => ({
      rule: v.rule,
      severity: v.severity,
      title: v.title,
      detail: v.detail,
      measured: v.measured,
      required: v.required,
      unit: v.unit,
      affects: v.entities.map(name),
      entity_ids: v.entities,
      fix: v.fix,
    }));
}

// ── The tools ────────────────────────────────────────────────────────────────

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback?: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function readTools(): ToolSpec[] {
  return [
    {
      name: 'get_plan',
      description:
        'Read the whole floor plan: every room with its position, size, area, neighbours and external walls; every door and window; every piece of furniture. Start here. All lengths are millimetres, x grows east and y grows south.',
      annotations: { title: 'Read the plan', readOnlyHint: true },
      inputSchema: obj({}),
      execute: () => {
        note('get_plan', 'Read the full plan.');
        return reply({ ok: true, summary: `${store.plan.name}: ${store.plan.rooms.length} rooms.`, plan: planForAgent(store.plan) });
      },
    },

    {
      name: 'check_plan',
      description:
        'Run every accessibility, daylight, circulation and layout rule over the plan and return what fails. Each finding carries the measured value, the value required, the entities involved and a concrete fix. Call this after any change to see whether it helped.',
      annotations: { title: 'Check the plan', readOnlyHint: true },
      inputSchema: obj({
        severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Only findings of this severity.' },
        rule: { type: 'string', description: 'Only this rule id, e.g. "door.clear_width".' },
      }),
      execute: (args) => {
        const a = analyse(store.plan);
        const list = issuesForAgent(store.plan, s(args.severity) || undefined, s(args.rule) || undefined);
        note('check_plan', `${a.stats.errorCount} error(s), ${a.stats.warningCount} warning(s).`);
        return reply({
          ok: true,
          summary:
            a.violations.length === 0
              ? 'The plan passes every rule.'
              : `${a.stats.errorCount} error(s) and ${a.stats.warningCount} warning(s). Score ${a.stats.score}/100.`,
          score: a.stats.score,
          findings: list,
        });
      },
    },

    {
      name: 'analyse_access',
      description:
        'Measure how much of the home a wheelchair user can actually reach from the front door, room by room, plus the clear width of every doorway and the largest turning circle in each room. Use this when someone asks whether the home works for a wheelchair, a walker, or moving furniture in.',
      annotations: { title: 'Accessibility analysis', readOnlyHint: true },
      inputSchema: obj({
        mobility_diameter_mm: {
          type: 'number',
          description: 'Width of the body being tested, mm. Defaults to the plan setting (900 mm).',
        },
      }),
      execute: (args) => {
        const plan = store.plan;
        const diameter = num(args.mobility_diameter_mm);
        const working: Plan = diameter
          ? { ...plan, settings: { ...plan.settings, mobilityRadius: Math.round(diameter / 2) } }
          : plan;
        const a = analyse(working);
        const doors = working.openings
          .filter((o) => o.kind !== 'window')
          .map((o) => ({
            id: o.id,
            in_room: working.rooms.find((r) => r.id === o.roomId)?.name,
            leads_to: working.rooms.find((r) => r.id === openingNeighbour(working, o))?.name ?? 'outside',
            structural_width_mm: o.width,
            clear_width_mm: doorClearWidth(working, a.grid, o.id),
          }))
          .sort((x, y) => x.clear_width_mm - y.clear_width_mm);
        note('analyse_access', `${Math.round(a.stats.reachableRatio * 100)}% reachable.`);
        return reply({
          ok: true,
          summary: `${a.stats.reachableAreaM2} m² of ${a.stats.totalAreaM2} m² (${Math.round(
            a.stats.reachableRatio * 100,
          )}%) is reachable with a ${working.settings.mobilityRadius * 2} mm body.`,
          tested_diameter_mm: working.settings.mobilityRadius * 2,
          reachable_area_m2: a.stats.reachableAreaM2,
          total_area_m2: a.stats.totalAreaM2,
          rooms: a.rooms.map((r) => ({
            name: r.name,
            reachable_fraction: r.reachRatio,
            turning_circle_mm: r.turningCircleMm,
            area_m2: r.areaM2,
            verdict:
              r.reachRatio < 0.05
                ? 'cut off entirely'
                : r.reachRatio < 0.6
                  ? 'only partly usable'
                  : r.turningCircleMm < working.settings.turningCircle
                    ? 'reachable, but no room to turn'
                    : 'fine',
          })),
          doorways: doors,
          tightest_doorway: doors[0],
        });
      },
    },

    {
      name: 'measure',
      description:
        'Measure the plan like a tape measure. Give two things — room names, furniture labels, opening ids, or literal "x,y" points in millimetres — and get the straight-line distance between them plus the clear floor radius at each end.',
      annotations: { title: 'Measure', readOnlyHint: true },
      inputSchema: obj(
        {
          from: { type: 'string', description: 'A room, furniture item, opening id, or "x,y" in mm.' },
          to: { type: 'string', description: 'A room, furniture item, opening id, or "x,y" in mm.' },
        },
        ['from', 'to'],
      ),
      execute: (args) => {
        const plan = store.plan;
        const a = analyse(plan);
        const resolve = (ref: string) => {
          const literal = ref.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
          if (literal) return { label: `point ${ref}`, x: Number(literal[1]), y: Number(literal[2]) };
          const room = findRoom(plan, ref);
          if (room) return { label: room.name, ...rectCentre(roomRect(room)) };
          const f = findFurniture(plan, ref);
          if (f) return { label: f.label, x: f.cx, y: f.cy };
          const op = findOpening(plan, ref);
          if (op) {
            const r = plan.rooms.find((x) => x.id === op.roomId);
            if (r) return { label: `${op.kind} in ${r.name}`, ...rectCentre(roomRect(r)) };
          }
          return null;
        };
        const from = resolve(s(args.from));
        const to = resolve(s(args.to));
        if (!from || !to) {
          return replyError(`Could not resolve ${!from ? `"${s(args.from)}"` : `"${s(args.to)}"`}.`, {
            hint: `Rooms in this plan: ${roomNames(plan)}. You can also pass "x,y" in millimetres.`,
          });
        }
        const distance = Math.round(Math.hypot(to.x - from.x, to.y - from.y));
        note('measure', `${from.label} → ${to.label}: ${distance} mm.`);
        return reply({
          ok: true,
          summary: `${from.label} to ${to.label} is ${distance} mm (${(distance / 1000).toFixed(2)} m).`,
          distance_mm: distance,
          from: { ...from, clear_radius_mm: Math.round(clearanceAt(a.grid, from.x, from.y)) },
          to: { ...to, clear_radius_mm: Math.round(clearanceAt(a.grid, to.x, to.y)) },
        });
      },
    },

    {
      name: 'list_catalog',
      description:
        'List the furniture and fixtures that can be placed, with real dimensions in millimetres and the clear floor each one needs in front of it to be usable.',
      annotations: { title: 'Furniture catalogue', readOnlyHint: true },
      inputSchema: obj({
        for_room_type: {
          type: 'string',
          enum: ROOM_TYPE_KEYS,
          description: 'Only items normally found in this kind of room.',
        },
      }),
      execute: (args) => {
        const filter = s(args.for_room_type) as RoomType;
        const items = CATALOG.filter((c) => (filter ? c.rooms.includes(filter) : true));
        return reply({
          ok: true,
          summary: `${items.length} item(s) available.`,
          items: items.map((c) => ({
            type: c.type,
            label: c.label,
            width_mm: c.w,
            depth_mm: c.h,
            clear_floor_in_front_mm: c.approach,
            typical_rooms: c.rooms,
          })),
          room_types: ROOM_TYPE_KEYS.map((k) => ({
            type: k,
            label: ROOM_TYPES[k].label,
            min_area_m2: ROOM_TYPES[k].minArea,
          })),
        });
      },
    },

    {
      name: 'get_selection',
      description:
        'See what the person at the keyboard currently has selected, which editing mode they are in, and which overlays are switched on. Call this when they say "this room", "that door" or "here" — the page knows what they mean.',
      annotations: { title: 'What the user is looking at', readOnlyHint: true },
      inputSchema: obj({}),
      execute: () => {
        const sel = store.selection;
        const plan = store.plan;
        let described: unknown = null;
        if (sel?.kind === 'room') {
          const r = findRoom(plan, sel.id);
          const stat = analyse(plan).rooms.find((x) => x.id === sel.id);
          if (r) described = { kind: 'room', id: r.id, name: r.name, type: r.type, area_m2: areaM2(roomRect(r)), stats: stat };
        } else if (sel?.kind === 'furniture') {
          const f = findFurniture(plan, sel.id);
          if (f) described = { kind: 'furniture', id: f.id, label: f.label, x_mm: f.cx, y_mm: f.cy, rotation_deg: f.rot };
        } else if (sel?.kind === 'opening') {
          const o = findOpening(plan, sel.id);
          if (o) described = { kind: 'opening', id: o.id, opening_kind: o.kind, width_mm: o.width, in_room: plan.rooms.find((r) => r.id === o.roomId)?.name };
        }
        return reply({
          ok: true,
          summary: described ? `Selected: ${JSON.stringify(described)}` : 'Nothing is selected right now.',
          selection: described,
          mode: store.mode,
          approval_required: store.requireApproval,
          overlays: store.overlays,
        });
      },
    },

    {
      name: 'get_activity',
      description:
        'Read the shared edit history — what changed, when, and whether a person or an agent did it. Useful for picking up where a previous session left off, or for explaining what you just did.',
      annotations: { title: 'Edit history', readOnlyHint: true },
      inputSchema: obj({ limit: { type: 'number', description: 'How many entries, newest first. Default 20.' } }),
      execute: (args) => {
        const limit = Math.max(1, Math.min(100, num(args.limit, 20)!));
        return reply({
          ok: true,
          summary: `${store.activity.length} entries in this session.`,
          entries: store.activity.slice(0, limit).map((e) => ({
            when: new Date(e.ts).toISOString(),
            by: e.actor,
            what: e.label,
            detail: e.detail,
            tool: e.tool,
          })),
        });
      },
    },
  ];
}

function writeTools(): ToolSpec[] {
  return [
    {
      name: 'add_room',
      description:
        'Add a rectangular room. Place it flush against an existing room with against_room + against_side (the usual way — rooms must meet edge to edge, never overlap), or give absolute x_mm / y_mm.',
      annotations: { title: 'Add a room', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          type: { type: 'string', enum: ROOM_TYPE_KEYS, description: 'What kind of room.' },
          width_mm: { type: 'number', description: 'East-west clear dimension.' },
          depth_mm: { type: 'number', description: 'North-south clear dimension.' },
          name: { type: 'string', description: 'Optional label, e.g. "Nursery".' },
          against_room: { ...ROOM_REF, description: 'Attach flush to this room.' },
          against_side: { ...SIDE_ENUM, description: 'Which side of that room to attach to.' },
          align_mm: { type: 'number', description: 'Slide along that wall from its start, mm.' },
          x_mm: { type: 'number', description: 'Absolute position instead of against_room.' },
          y_mm: { type: 'number', description: 'Absolute position instead of against_room.' },
        },
        ['type', 'width_mm', 'depth_mm'],
      ),
      execute: (args) =>
        mutate(
          'add_room',
          (draft) =>
            addRoom(draft, {
              type: s(args.type) as RoomType,
              widthMm: num(args.width_mm, 3000)!,
              depthMm: num(args.depth_mm, 3000)!,
              name: s(args.name) || undefined,
              againstRoom: s(args.against_room) || undefined,
              againstSide: (s(args.against_side) as Side) || undefined,
              alignMm: num(args.align_mm),
              xMm: num(args.x_mm),
              yMm: num(args.y_mm),
            }),
          { title: `Add a ${s(args.type)}`, spotlight: (p) => [p.rooms[p.rooms.length - 1]?.id ?? ''] },
        ),
    },

    {
      name: 'edit_room',
      description:
        'Change one room: resize it, move it, rename it, or change what kind of room it is. Only the fields you pass are touched. Resizing is rejected if it would overlap a neighbour, so move the neighbour first.',
      annotations: { title: 'Edit a room', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          room: ROOM_REF,
          width_mm: { type: 'number' },
          depth_mm: { type: 'number' },
          anchor: {
            type: 'string',
            enum: ['centre', 'n', 'e', 's', 'w'],
            description: 'Which edge stays put while resizing. Default centre.',
          },
          dx_mm: { type: 'number', description: 'Move east by this much (negative for west).' },
          dy_mm: { type: 'number', description: 'Move south by this much (negative for north).' },
          name: { type: 'string' },
          type: { type: 'string', enum: ROOM_TYPE_KEYS },
        },
        ['room'],
      ),
      execute: (args) =>
        mutate(
          'edit_room',
          (draft) => {
            const ref = s(args.room);
            const messages: string[] = [];
            if (args.width_mm !== undefined || args.depth_mm !== undefined) {
              const r = resizeRoom(
                draft,
                ref,
                num(args.width_mm),
                num(args.depth_mm),
                (s(args.anchor) as Side | 'centre') || 'centre',
              );
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.dx_mm !== undefined || args.dy_mm !== undefined) {
              const r = moveRoom(draft, ref, num(args.dx_mm, 0)!, num(args.dy_mm, 0)!);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.name !== undefined) {
              const r = renameRoom(draft, ref, s(args.name));
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.type !== undefined) {
              const r = setRoomType(draft, ref, s(args.type) as RoomType);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (messages.length === 0) {
              return { ok: false, error: 'Nothing to change.', hint: 'Pass at least one of width_mm, depth_mm, dx_mm, dy_mm, name or type.' };
            }
            return { ok: true, value: null, message: messages.join(' ') };
          },
          { title: `Edit ${s(args.room)}`, spotlight: (p) => [findRoom(p, s(args.room))?.id ?? ''] },
        ),
    },

    {
      name: 'add_opening',
      description:
        'Cut a door, archway or window into a wall. For an internal door give to_room and the side is worked out for you. For a front door or a window set exterior: true. Openings wider than 1400 mm become archways with no leaf.',
      annotations: { title: 'Add a door or window', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          room: ROOM_REF,
          kind: { type: 'string', enum: ['door', 'window', 'archway'] },
          to_room: { ...ROOM_REF, description: 'For internal doors: the room on the other side.' },
          side: SIDE_ENUM,
          exterior: { type: 'boolean', description: 'True for a front door or a window onto the outside.' },
          width_mm: { type: 'number', description: 'Structural width. Doors default to 900 mm, windows to 1200 mm.' },
          offset_mm: { type: 'number', description: 'Distance along the wall from its start. Omit to centre it.' },
          swing: { type: 'string', enum: ['n', 'e', 's', 'w', 'none'], description: 'Which way a door leaf opens.' },
          sill_mm: { type: 'number', description: 'Windows: height of the sill above the floor.' },
          head_mm: { type: 'number', description: 'Windows: height of the head above the floor.' },
        },
        ['room', 'kind'],
      ),
      execute: (args) =>
        mutate(
          'add_opening',
          (draft) =>
            addOpening(draft, {
              roomRef: s(args.room),
              side: (s(args.side) as Side) || 'n',
              kind: (s(args.kind) as 'door' | 'window' | 'archway') || 'door',
              toRoom: s(args.to_room) || undefined,
              exterior: args.exterior === true,
              widthMm: num(args.width_mm),
              offsetMm: num(args.offset_mm),
              swing: (s(args.swing) as Side | 'none') || undefined,
              sillMm: num(args.sill_mm),
              headMm: num(args.head_mm),
            }),
          { title: `Add a ${s(args.kind) || 'door'}`, spotlight: (p) => [p.openings[p.openings.length - 1]?.id ?? ''] },
        ),
    },

    {
      name: 'edit_opening',
      description:
        'Change a door or window that already exists: widen it, slide it along its wall, or reverse the way the leaf swings. Widening a door is the usual fix for a room that measures as unreachable.',
      annotations: { title: 'Edit a door or window', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          opening_id: { type: 'string', description: 'Id from get_plan or check_plan.' },
          width_mm: { type: 'number' },
          offset_mm: { type: 'number' },
          swing: { type: 'string', enum: ['n', 'e', 's', 'w', 'none'] },
        },
        ['opening_id'],
      ),
      execute: (args) =>
        mutate(
          'edit_opening',
          (draft) => {
            const id = s(args.opening_id);
            const messages: string[] = [];
            if (args.width_mm !== undefined) {
              const r = setOpeningWidth(draft, id, num(args.width_mm, 900)!);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.offset_mm !== undefined) {
              const r = moveOpening(draft, id, num(args.offset_mm, 0)!);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.swing !== undefined) {
              const r = setDoorSwing(draft, id, s(args.swing) as Side | 'none');
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (messages.length === 0)
              return { ok: false, error: 'Nothing to change.', hint: 'Pass width_mm, offset_mm or swing.' };
            return { ok: true, value: null, message: messages.join(' ') };
          },
          { title: 'Edit an opening', spotlight: () => [s(args.opening_id)] },
        ),
    },

    {
      name: 'add_furniture',
      description:
        'Place a piece of furniture or a fixture. Give a room and it is parked against a free wall facing into the room; give x_mm / y_mm to put it exactly somewhere. Use list_catalog for the available types.',
      annotations: { title: 'Place furniture', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          type: { type: 'string', description: 'Catalog type, e.g. "bed_double". See list_catalog.' },
          room: ROOM_REF,
          against_side: { ...SIDE_ENUM, description: 'Prefer this wall.' },
          x_mm: { type: 'number', description: 'Exact centre position instead of automatic placement.' },
          y_mm: { type: 'number' },
          rotation_deg: { type: 'number', enum: [0, 90, 180, 270] },
          label: { type: 'string', description: 'Optional custom label.' },
        },
        ['type', 'room'],
      ),
      execute: (args) =>
        mutate(
          'add_furniture',
          (draft) =>
            addFurniture(draft, {
              type: s(args.type),
              roomRef: s(args.room),
              againstSide: (s(args.against_side) as Side) || undefined,
              xMm: num(args.x_mm),
              yMm: num(args.y_mm),
              rot: num(args.rotation_deg) as 0 | 90 | 180 | 270 | undefined,
              label: s(args.label) || undefined,
            }),
          { title: `Place ${s(args.type)}`, spotlight: (p) => [p.furniture[p.furniture.length - 1]?.id ?? ''] },
        ),
    },

    {
      name: 'edit_furniture',
      description:
        'Move or rotate a piece of furniture. Reference it by label, type or id. Rotation is clockwise; 0° faces south.',
      annotations: { title: 'Move furniture', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          item: { type: 'string', description: 'Furniture label, type or id.' },
          x_mm: { type: 'number' },
          y_mm: { type: 'number' },
          dx_mm: { type: 'number', description: 'Relative move east.' },
          dy_mm: { type: 'number', description: 'Relative move south.' },
          rotation_deg: { type: 'number', enum: [0, 90, 180, 270] },
        },
        ['item'],
      ),
      execute: (args) =>
        mutate(
          'edit_furniture',
          (draft) => {
            const ref = s(args.item);
            const f = findFurniture(draft, ref);
            if (!f) return { ok: false, error: `No furniture called "${ref}".`, hint: 'Call get_plan for the list.' };
            const messages: string[] = [];
            const x = num(args.x_mm, f.cx + num(args.dx_mm, 0)!)!;
            const y = num(args.y_mm, f.cy + num(args.dy_mm, 0)!)!;
            if (x !== f.cx || y !== f.cy) {
              const r = moveFurniture(draft, f.id, x, y);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (args.rotation_deg !== undefined) {
              const r = rotateFurniture(draft, f.id, num(args.rotation_deg, 0) as 0 | 90 | 180 | 270);
              if (!r.ok) return r;
              messages.push(r.message);
            }
            if (messages.length === 0)
              return { ok: false, error: 'Nothing to change.', hint: 'Pass x_mm/y_mm, dx_mm/dy_mm or rotation_deg.' };
            return { ok: true, value: null, message: messages.join(' ') };
          },
          { title: `Move ${s(args.item)}`, spotlight: (p) => [findFurniture(p, s(args.item))?.id ?? ''] },
        ),
    },

    {
      name: 'furnish_room',
      description:
        'Fill a room with a sensible kit for its type — a bed, wardrobe and bedside for a bedroom; counter, fridge, oven and sink for a kitchen — parked against the walls so the middle stays clear. Follow with check_plan.',
      annotations: { title: 'Furnish a room', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          room: ROOM_REF,
          extra_items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional catalog types to add on top of the standard kit.',
          },
        },
        ['room'],
      ),
      execute: (args) =>
        mutate(
          'furnish_room',
          (draft) =>
            furnishRoom(
              draft,
              s(args.room),
              Array.isArray(args.extra_items) ? (args.extra_items as string[]).map(String) : [],
            ),
          { title: `Furnish ${s(args.room)}` },
        ),
    },

    {
      name: 'delete_entity',
      description:
        'Remove a room, a door or window, or a piece of furniture. Deleting a room also deletes its openings and everything inside it. This always asks the person at the keyboard first.',
      annotations: { title: 'Delete something', readOnlyHint: false, destructiveHint: true },
      inputSchema: obj(
        {
          kind: { type: 'string', enum: ['room', 'opening', 'furniture'] },
          reference: { type: 'string', description: 'Id, name or label of the thing to remove.' },
        },
        ['kind', 'reference'],
      ),
      execute: (args) =>
        mutate(
          'delete_entity',
          (draft) => {
            const ref = s(args.reference);
            switch (s(args.kind)) {
              case 'room':
                return deleteRoom(draft, ref);
              case 'opening':
                return deleteOpening(draft, ref);
              case 'furniture':
                return deleteFurniture(draft, ref);
              default:
                return { ok: false, error: 'kind must be "room", "opening" or "furniture".' };
            }
          },
          { destructive: true, title: `Delete ${s(args.kind)} "${s(args.reference)}"` },
        ),
    },

    {
      name: 'clear_room',
      description: 'Take every piece of furniture out of one room, leaving the shell. Asks for confirmation.',
      annotations: { title: 'Empty a room', readOnlyHint: false, destructiveHint: true },
      inputSchema: obj({ room: ROOM_REF }, ['room']),
      execute: (args) =>
        mutate('clear_room', (draft) => clearRoom(draft, s(args.room)), {
          destructive: true,
          title: `Empty ${s(args.room)}`,
        }),
    },

    {
      name: 'set_standards',
      description:
        'Change the accessibility standards the plan is measured against — the body diameter used for circulation, the turning circle, the minimum clear doorway. Raise them to design for a wheelchair user; lower them to check an existing home against a walking frame.',
      annotations: { title: 'Set standards', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj({
        mobility_diameter_mm: { type: 'number', description: 'Body width used for circulation. 900 mm is the wheelchair default.' },
        turning_circle_mm: { type: 'number', description: 'Clear circle required in key rooms. 1500 mm is standard.' },
        min_clear_door_mm: { type: 'number', description: 'Minimum clear doorway. 815 mm is the usual figure.' },
      }),
      execute: (args) =>
        mutate(
          'set_standards',
          (draft) =>
            setSettings(draft, {
              ...(args.mobility_diameter_mm !== undefined
                ? { mobilityRadius: Math.round(num(args.mobility_diameter_mm, 900)! / 2) }
                : {}),
              ...(args.turning_circle_mm !== undefined ? { turningCircle: num(args.turning_circle_mm, 1500)! } : {}),
              ...(args.min_clear_door_mm !== undefined ? { minClearDoor: num(args.min_clear_door_mm, 815)! } : {}),
            }),
          { title: 'Change the standards this plan is checked against' },
        ),
    },

    {
      name: 'undo_last',
      description: 'Undo the most recent change, whoever made it. Use this when the person says an edit was wrong.',
      annotations: { title: 'Undo', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj({}),
      execute: () => {
        if (!store.canUndo) return replyError('There is nothing left to undo.');
        store.undo();
        note('undo_last', 'Rolled back one step.');
        const a = analyse(store.plan);
        return reply({ ok: true, summary: 'Undid the last change.', remaining_errors: a.stats.errorCount });
      },
    },

    {
      name: 'load_sample',
      description:
        'Replace the whole drawing with a starter plan: "apartment" for a furnished two-bedroom flat with real problems in it, or "shell" for an empty 48 m² box to design from scratch. Asks for confirmation because it discards the current plan.',
      annotations: { title: 'Load a starter plan', readOnlyHint: false, destructiveHint: true },
      inputSchema: obj({ which: { type: 'string', enum: ['apartment', 'shell'] } }, ['which']),
      execute: (args) =>
        mutate(
          'load_sample',
          (draft) => {
            const next = s(args.which) === 'shell' ? shellPlan() : starterPlan();
            draft.name = next.name;
            draft.rooms = next.rooms;
            draft.openings = next.openings;
            draft.furniture = next.furniture;
            draft.settings = next.settings;
            return { ok: true, value: null, message: `Loaded the "${s(args.which)}" starter plan.` };
          },
          { destructive: true, title: `Load the ${s(args.which)} starter plan` },
        ),
    },
  ];
}

/** Tools that touch the view rather than the drawing. */
function viewTools(): ToolSpec[] {
  return [
    {
      name: 'highlight',
      description:
        'Point at things on the plan so the person can see what you are talking about. Pass room names, furniture labels or entity ids; they pulse on the canvas for a few seconds. Does not change the drawing.',
      annotations: { title: 'Point at something', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: obj(
        {
          targets: { type: 'array', items: { type: 'string' }, description: 'Rooms, furniture or ids to flash.' },
          label: { type: 'string', description: 'Short caption shown beside them.' },
        },
        ['targets'],
      ),
      execute: (args) => {
        const refs = Array.isArray(args.targets) ? (args.targets as unknown[]).map(String) : [];
        const ids = refs
          .map(
            (r) =>
              findRoom(store.plan, r)?.id ??
              findFurniture(store.plan, r)?.id ??
              findOpening(store.plan, r)?.id ??
              null,
          )
          .filter((x): x is string => Boolean(x));
        if (ids.length === 0) {
          return replyError('None of those matched anything on the plan.', {
            hint: `Rooms in this plan: ${roomNames(store.plan)}.`,
          });
        }
        store.flash(ids, s(args.label) || undefined, 5000);
        note('highlight', `Pointed at ${refs.join(', ')}.`);
        return reply({ ok: true, summary: `Highlighted ${ids.length} item(s) on screen for the user.` });
      },
    },

    {
      name: 'set_view',
      description:
        'Turn the drawing overlays on and off so the person can see what you measured: the clearance heatmap, the step-free reachable area, door swings, and the clear floor each item needs. Use this to show your reasoning rather than describing it.',
      annotations: { title: 'Change the view', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: obj({
        heatmap: { type: 'boolean', description: 'Colour the floor by how much clear space there is.' },
        reach: { type: 'boolean', description: 'Shade what can be reached from the front door.' },
        swings: { type: 'boolean', description: 'Draw door swing arcs.' },
        approach: { type: 'boolean', description: 'Draw the clear floor each fitting needs.' },
        dimensions: { type: 'boolean', description: 'Show room dimensions.' },
      }),
      execute: (args) => {
        const changed: string[] = [];
        for (const key of ['heatmap', 'reach', 'swings', 'approach', 'dimensions'] as const) {
          if (typeof args[key] === 'boolean') {
            store.overlays[key] = args[key] as boolean;
            changed.push(`${key}=${args[key]}`);
          }
        }
        if (changed.length === 0)
          return replyError('Nothing to change.', { hint: 'Pass one or more of heatmap, reach, swings, approach, dimensions.' });
        store.emit();
        note('set_view', changed.join(', '));
        return reply({ ok: true, summary: `View updated: ${changed.join(', ')}.`, overlays: store.overlays });
      },
    },

  ];
}

/**
 * Tools that only exist in certain states. This is the part of WebMCP that has
 * no equivalent in a static tool manifest: the page decides, moment to moment,
 * what an agent is even able to ask for.
 */
function contextualTools(): ToolSpec[] {
  const out: ToolSpec[] = [];
  const analysis = analyse(store.plan);

  if (analysis.violations.length > 0 && store.mode !== 'review') {
    const rules = [...new Set(analysis.violations.map((v) => v.rule))];
    out.push({
      name: 'fix_violation',
      description:
        `Apply the standard repair for one finding from check_plan — widen the door, add the window, re-park the furniture that is blocking the turning circle. Currently repairable rules: ${rules.join(', ')}. Prefer this over hand-editing when the fix is obvious.`,
      annotations: { title: 'Repair a finding', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          rule: { type: 'string', enum: rules, description: 'The rule id from check_plan.' },
          entity: { type: 'string', description: 'Optional: which room, door or item, when the rule fires more than once.' },
        },
        ['rule'],
      ),
      execute: (args) =>
        mutate(
          'fix_violation',
          (draft) => {
            const current = analyse(draft).violations;
            const target = findViolation(current, s(args.rule), s(args.entity) || undefined, draft);
            if (!target)
              return {
                ok: false,
                error: `Nothing currently fails rule "${s(args.rule)}".`,
                hint: 'Call check_plan for the live list.',
              };
            const outcome = applyFix(draft, target);
            if (!outcome.applied)
              return { ok: false, error: outcome.reason ?? 'That finding has no automatic repair.', hint: target.fix };
            return { ok: true, value: null, message: `${target.title} — ${outcome.actions.join(' ')}` };
          },
          { title: `Repair: ${s(args.rule)}` },
        ),
    });
  }

  if (store.selection && store.mode !== 'review') {
    const sel = store.selection;
    const label =
      sel.kind === 'room'
        ? findRoom(store.plan, sel.id)?.name
        : sel.kind === 'furniture'
          ? findFurniture(store.plan, sel.id)?.label
          : findOpening(store.plan, sel.id)?.kind;
    out.push({
      name: 'edit_selection',
      description:
        `Act on whatever the person currently has selected — right now that is the ${sel.kind} "${label ?? sel.id}". Use this when they say "make this wider", "move this", "turn this round". Saves you having to resolve what "this" means.`,
      annotations: { title: 'Edit the current selection', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj({
        width_mm: { type: 'number', description: 'Room width, or opening width.' },
        depth_mm: { type: 'number', description: 'Rooms only.' },
        dx_mm: { type: 'number' },
        dy_mm: { type: 'number' },
        rotation_deg: { type: 'number', enum: [0, 90, 180, 270], description: 'Furniture only.' },
        name: { type: 'string', description: 'Rooms only.' },
      }),
      execute: (args) =>
        mutate(
          'edit_selection',
          (draft) => {
            const messages: string[] = [];
            if (sel.kind === 'room') {
              if (args.width_mm !== undefined || args.depth_mm !== undefined) {
                const r = resizeRoom(draft, sel.id, num(args.width_mm), num(args.depth_mm));
                if (!r.ok) return r;
                messages.push(r.message);
              }
              if (args.dx_mm !== undefined || args.dy_mm !== undefined) {
                const r = moveRoom(draft, sel.id, num(args.dx_mm, 0)!, num(args.dy_mm, 0)!);
                if (!r.ok) return r;
                messages.push(r.message);
              }
              if (args.name !== undefined) {
                const r = renameRoom(draft, sel.id, s(args.name));
                if (!r.ok) return r;
                messages.push(r.message);
              }
            } else if (sel.kind === 'furniture') {
              const f = findFurniture(draft, sel.id);
              if (!f) return { ok: false, error: 'The selected item is gone.' };
              if (args.dx_mm !== undefined || args.dy_mm !== undefined) {
                const r = moveFurniture(draft, f.id, f.cx + num(args.dx_mm, 0)!, f.cy + num(args.dy_mm, 0)!);
                if (!r.ok) return r;
                messages.push(r.message);
              }
              if (args.rotation_deg !== undefined) {
                const r = rotateFurniture(draft, f.id, num(args.rotation_deg, 0) as 0 | 90 | 180 | 270);
                if (!r.ok) return r;
                messages.push(r.message);
              }
            } else {
              if (args.width_mm !== undefined) {
                const r = setOpeningWidth(draft, sel.id, num(args.width_mm, 900)!);
                if (!r.ok) return r;
                messages.push(r.message);
              }
              if (args.dx_mm !== undefined) {
                const op = findOpening(draft, sel.id);
                if (!op) return { ok: false, error: 'The selected opening is gone.' };
                const r = moveOpening(draft, op.id, op.offset + num(args.dx_mm, 0)!);
                if (!r.ok) return r;
                messages.push(r.message);
              }
            }
            if (messages.length === 0)
              return { ok: false, error: 'Nothing to change on the current selection.' };
            return { ok: true, value: null, message: messages.join(' ') };
          },
          { title: 'Edit the current selection', spotlight: () => [sel.id] },
        ),
    });
  }

  if (store.proposal) {
    out.push({
      name: 'check_proposal',
      description:
        'A change you proposed is waiting for the person at the keyboard to approve or discard. Call this to see what is on screen. Editing tools are unavailable until they decide.',
      annotations: { title: 'Pending approval', readOnlyHint: true },
      inputSchema: obj({}),
      execute: () =>
        reply({
          ok: true,
          summary: `Waiting on the user: "${store.proposal?.title}".`,
          proposed_by_tool: store.proposal?.tool,
          changes: store.proposal?.changes,
          waiting_for_ms: Date.now() - (store.proposal?.created ?? Date.now()),
        }),
    });
  }

  return out;
}

/**
 * The live tool set.
 *
 * Read tools are always there. Write tools disappear in review mode and while a
 * proposal is on screen, so an agent physically cannot queue up edits behind a
 * decision the user has not made yet.
 */
export function buildTools(): ToolSpec[] {
  const tools = [...readTools(), ...viewTools()];
  if (store.mode !== 'review' && !store.proposal) tools.push(...writeTools());
  tools.push(...contextualTools());
  return tools;
}

let pending = 0;

/** Keeps registration in step with the state, coalescing bursts of changes. */
export function wireTools(): void {
  const sync = () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(() => void host.sync(buildTools()), 60);
  };
  store.subscribe(sync);
  sync();
}

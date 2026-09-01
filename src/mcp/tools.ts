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
import { areaM2, openingNeighbour, openingRect, rectCentre, roomRect, wallSegments } from '../core/geometry';
import { clearanceAt, doorClearWidth } from '../core/grid';
import {
  findEntity,
  findFurniture,
  findOpening,
  findRoom,
  moveFurniture,
  moveOpening,
  moveRoom,
  renameRoom,
  resizeRoom,
  rotateFurniture,
  roomNames,
  setOpeningWidth,
} from '../core/ops';
import { describeJourney, planJourney } from '../core/route';
import { rescale } from '../core/underlay';
import { analyse } from '../core/rules';
import { accessiblePlan, shellPlan, starterPlan } from '../core/samples';
import { shareLink } from '../core/share';
import { planToSchedule, planToSvg } from '../core/svg';
import { store } from '../core/store';
import type { Plan, RoomType } from '../core/types';
import { describeDelta, issueDelta, requestApproval } from './gate';
import {
  OPERATION_NAMES,
  RUNNERS,
  num,
  runBatch,
  s,
  type ArgMap,
  type Runner,
} from './operations';
import { host, reply, replyError, type ToolContent, type ToolSpec } from './runtime';
import { listProperties, validateArgs, type ToolSchema } from './validate';

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

/** Puts a familiar name to a body width, so results read like sentences. */
function describeBody(diameterMm: number): string {
  if (diameterMm <= 650) return 'a walking stick or crutches';
  if (diameterMm <= 750) return 'a walking frame';
  if (diameterMm <= 850) return 'a narrow manual wheelchair';
  if (diameterMm <= 950) return 'a standard wheelchair';
  if (diameterMm <= 1100) return 'a large powered chair';
  return 'a mobility scooter';
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

function readTools(): ToolSpec[] {
  return [
    {
      name: 'get_capabilities',
      description:
        'What this page can and cannot do, in one call. Read it before attempting anything unusual, and read it when a request does not obviously map onto a tool — it lists the limits explicitly, so you can tell someone plainly that a thing is not possible here and offer the nearest thing that is, instead of guessing.',
      annotations: { title: 'What can I do here?', readOnlyHint: true },
      inputSchema: obj({}),
      execute: () => {
        const registered = buildTools();
        note('get_capabilities', 'Read what the app can do.');
        return reply({
          ok: true,
          summary:
            'Groundplan is a single-storey floor plan editor with an accessibility rule engine. You can read and measure the drawing, and propose changes that the person approves. Lengths are millimetres; x grows east and y grows south.',
          the_model: {
            rooms: 'Axis-aligned rectangles that meet edge to edge. Walls are derived from where rooms touch, not drawn separately. Rooms joined by an archway 1400 mm or wider count as one space for floor area, daylight and turning circle — that is how open plan and L-shaped rooms are drawn.',
            openings: 'Doors, archways and windows cut into a room wall, given a side and an offset along it.',
            furniture: 'Rectangles from a fixed catalogue, rotated in quarter turns, each with the clear floor it needs in front.',
            settings: 'The body diameter, turning circle and clear doorway the plan is checked against — all adjustable with edit_plan.',
          },
          how_to_work: [
            'Start with get_plan, then check_plan. Findings carry the measured value, the required value and a fix.',
            'Prefer apply_batch for anything that takes more than one step: it is one approval for the person and it is atomic.',
            'After a change, read issues.resolved and issues.introduced in the result rather than calling check_plan again.',
            'Use show_route when someone asks why somewhere is unreachable — showing beats quoting a number.',
            'Every mutating call may stop at a consent dialog. If the result says approved: false, nothing happened; ask what they would prefer.',
          ],
          cannot_do: [
            {
              asked_for: 'L-shaped, curved or angled rooms',
              why: 'Rooms are axis-aligned rectangles.',
              instead: 'Draw the space as two or more rectangles that touch, joined by an archway 1400 mm or wider. The rule engine then pools their floor area, daylight and turning circle, so it is measured as one room rather than a big room and a failing small one.',
            },
            {
              asked_for: 'More than one storey, or stairs',
              why: 'Groundplan models one floor at a time and has no stair geometry.',
              instead: 'Check each storey as its own plan.',
            },
            {
              asked_for: 'A 3D view or a walkthrough',
              why: 'There is no 3D renderer; the app deliberately works in plan.',
              instead: 'show_route sends a body of a stated width along the real route at full scale and stops it where it stops fitting.',
            },
            {
              asked_for: 'Loading a photo or a PDF of a plan',
              why: 'A tool cannot read files; only the person can add one, by dropping or pasting an image onto the page.',
              instead: 'Ask them to drop the picture in. get_plan then reports it, and edit_underlay scales and positions it so you can trace over it.',
            },
            {
              asked_for: 'Ceiling heights, elevations, sections, finishes or costs',
              why: 'Only the plan is modelled. The one vertical dimension is a window sill and head.',
              instead: 'export_plan with format "schedule" gives areas and clearances, which is what an estimate would be built from.',
            },
            {
              asked_for: 'Turning off the approval gate, or leaving read-only mode',
              why: 'Those are the person’s controls over you, so no tool exposes them.',
              instead: 'Ask them to change it in the page. get_selection reports the current setting.',
            },
            {
              asked_for: 'Saving to a server, emailing, or printing',
              why: 'There is no backend and no account; nothing leaves the browser.',
              instead: 'export_plan with format "link" gives a URL that carries the whole drawing, which they can send to anyone.',
            },
            {
              asked_for: 'Compass orientation, sunlight or views',
              why: 'The plan has no true north and no sun model. n/e/s/w are directions on the drawing.',
              instead: 'The daylight rule measures glazing area against floor area, which is what check_plan reports.',
            },
          ],
          right_now: {
            plan: store.plan.name,
            rooms: store.plan.rooms.length,
            editing_allowed: store.mode !== 'review',
            approval_required: store.requireApproval,
            tracing_image_loaded: store.underlay !== null,
            tools_available: registered.map((t) => t.name),
          },
          note: 'Arguments are checked before anything runs. If you pass something this app does not model, the call is refused and the refusal says why — nothing is silently ignored.',
        });
      },
    },

    {
      name: 'get_plan',
      description:
        'Read the whole floor plan: every room with its position, size, area, neighbours and external walls; every door and window; every piece of furniture. Start here. All lengths are millimetres, x grows east and y grows south.',
      annotations: { title: 'Read the plan', readOnlyHint: true },
      inputSchema: obj({}),
      execute: () => {
        note('get_plan', 'Read the full plan.');
        const under = store.underlay;
        return reply({
          ok: true,
          summary: `${store.plan.name}: ${store.plan.rooms.length} rooms.`,
          plan: planForAgent(store.plan),
          // When someone is tracing a photograph of their home, the agent should
          // know it is there and where it sits, so "trace this" has coordinates.
          tracing_image: under
            ? {
                label: under.label,
                x_mm: under.x,
                y_mm: under.y,
                width_mm: under.width,
                height_mm: under.height,
                locked: under.locked,
                note: 'A reference picture the user is drawing over. Rooms you add should line up with it.',
              }
            : null,
        });
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
          summary: (() => {
            const worst = [...a.rooms].filter((r) => r.routeWidthMm > 0).sort((x, y) => x.routeWidthMm - y.routeWidthMm)[0];
            const base = `${a.stats.reachableAreaM2} m² of ${a.stats.totalAreaM2} m² (${Math.round(
              a.stats.reachableRatio * 100,
            )}%) is reachable with a ${working.settings.mobilityRadius * 2} mm body.`;
            return worst && worst.routeWidthMm < working.settings.mobilityRadius * 2
              ? `${base} The tightest route is into ${worst.name}: ${worst.routeWidthMm} mm at ${worst.routeLimit ?? 'an unidentified pinch'}.`
              : base;
          })(),
          tested_diameter_mm: working.settings.mobilityRadius * 2,
          reachable_area_m2: a.stats.reachableAreaM2,
          total_area_m2: a.stats.totalAreaM2,
          rooms: a.rooms.map((r) => ({
            name: r.name,
            reachable_fraction: r.reachRatio,
            turning_circle_mm: r.turningCircleMm,
            area_m2: r.areaM2,
            // The widest body that can reach this room, and what stops a wider
            // one. This is the number to act on when a room is cut off.
            route_width_mm: r.routeWidthMm,
            route_limited_by: r.routeLimit,
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
          tightest_route: [...a.rooms]
            .filter((r) => r.routeWidthMm > 0)
            .sort((x, y) => x.routeWidthMm - y.routeWidthMm)
            .slice(0, 3)
            .map((r) => `${r.name}: ${r.routeWidthMm} mm at ${r.routeLimit ?? 'an unidentified pinch'}`),
        });
      },
    },

    {
      name: 'compare_standards',
      description:
        'Measure the same home against several different bodies at once — a walking frame, a standard wheelchair, a large powered chair — and report what each one can reach and what stops it. This is the tool for "would this flat work for my mother?", and for separating how much of a problem is the home from how much is the chair.',
      annotations: { title: 'Compare mobility standards', readOnlyHint: true },
      inputSchema: obj({
        diameters_mm: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Body widths to test, mm. Defaults to 700, 900 and 1000 — a walking frame, the standard reference wheelchair, and a large powered chair.',
        },
      }),
      execute: (args) => {
        const plan = store.plan;
        const requested = Array.isArray(args.diameters_mm)
          ? (args.diameters_mm as unknown[])
              .map((d) => Math.round(Number(d)))
              .filter((d) => Number.isFinite(d) && d >= 400 && d <= 1800)
          : [];
        const diameters = (requested.length ? requested : [700, 900, 1000]).sort((a, b) => a - b);

        const results = diameters.map((diameter) => {
          const variant: Plan = {
            ...plan,
            settings: { ...plan.settings, mobilityRadius: Math.round(diameter / 2) },
          };
          const a = analyse(variant);
          const cutOff = a.rooms.filter((r) => r.reachRatio < 0.05);
          const tightest = [...a.rooms]
            .filter((r) => r.routeWidthMm > 0)
            .sort((x, y) => x.routeWidthMm - y.routeWidthMm)[0];
          return {
            body: describeBody(diameter),
            diameter_mm: diameter,
            reachable_percent: Math.round(a.stats.reachableRatio * 100),
            reachable_area_m2: a.stats.reachableAreaM2,
            rooms_cut_off: cutOff.map((r) => r.name),
            tightest_route: tightest
              ? `${tightest.name}: ${tightest.routeWidthMm} mm at ${tightest.routeLimit ?? 'an unidentified pinch'}`
              : null,
            doors_too_narrow: a.violations.filter((v) => v.rule === 'door.clear_width').length,
          };
        });

        note('compare_standards', results.map((r) => `${r.diameter_mm} mm: ${r.reachable_percent}%`).join(', '));

        // The interesting line is where it stops working.
        const works = results.filter((r) => r.rooms_cut_off.length === 0);
        const fails = results.filter((r) => r.rooms_cut_off.length > 0);
        const summary =
          fails.length === 0
            ? `Every body tested (${diameters.join(', ')} mm) reaches every room.`
            : works.length === 0
              ? `No body tested reaches the whole home. Even at ${diameters[0]} mm, ${fails[0]!.rooms_cut_off.join(' and ')} ${fails[0]!.rooms_cut_off.length === 1 ? 'is' : 'are'} cut off.`
              : `This home works up to ${works[works.length - 1]!.diameter_mm} mm. At ${fails[0]!.diameter_mm} mm, ${fails[0]!.rooms_cut_off.join(' and ')} ${fails[0]!.rooms_cut_off.length === 1 ? 'becomes' : 'become'} unreachable — ${fails[0]!.tightest_route}.`;

        return reply({ ok: true, summary, standards: results });
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
          const found = findEntity(plan, ref);
          if (!found) return null;
          if (found.kind === 'room') return { label: found.room.name, ...rectCentre(roomRect(found.room)) };
          if (found.kind === 'furniture') return { label: found.item.label, x: found.item.cx, y: found.item.cy };
          // The middle of the opening itself, not of the room it is cut into:
          // "how far from the door to the bed" has to mean the door.
          const hole = openingRect(plan, found.opening);
          const host = plan.rooms.find((x) => x.id === found.opening.roomId);
          return hole
            ? { label: `${found.opening.kind} in ${host?.name ?? 'the plan'}`, ...rectCentre(hole) }
            : null;
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
      name: 'export_plan',
      description:
        'Hand the person something they can keep: a shareable link that carries the whole drawing in the URL, a markdown room schedule to paste into a message, or the plan as SVG. Use "link" when you finish a piece of work — it is the fastest way to give someone the result.',
      annotations: { title: 'Export the plan', readOnlyHint: true },
      inputSchema: obj(
        {
          format: {
            type: 'string',
            enum: ['link', 'schedule', 'svg'],
            description:
              'link: a URL containing the plan. schedule: a markdown table of rooms, areas and clearances. svg: the drawing as vector source.',
          },
        },
        ['format'],
      ),
      execute: async (args) => {
        const plan = store.plan;
        const analysis = analyse(plan);
        const format = s(args.format) || 'link';
        note('export_plan', `Exported as ${format}.`);
        if (format === 'schedule') {
          return reply({
            ok: true,
            summary: `Room schedule for ${plan.name}.`,
            markdown: planToSchedule(plan, analysis),
          });
        }
        if (format === 'svg') {
          const svg = planToSvg(plan, { analysis, annotate: true });
          return reply({
            ok: true,
            summary: `${plan.name} as SVG, ${Math.round(svg.length / 1024)} kB of source.`,
            svg,
          });
        }
        const url = await shareLink(plan);
        return reply({
          ok: true,
          summary: 'A link carrying the whole plan. Nothing was uploaded — the drawing is in the URL itself.',
          url,
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
        mutate('add_room', RUNNERS.add_room!(args), {
          title: `Add a ${s(args.type)}`,
          spotlight: (p) => [p.rooms[p.rooms.length - 1]?.id ?? ''],
        }),
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
        mutate('edit_room', RUNNERS.edit_room!(args), {
          title: `Edit ${s(args.room)}`,
          spotlight: (p) => [findRoom(p, s(args.room))?.id ?? ''],
        }),
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
        mutate('add_opening', RUNNERS.add_opening!(args), {
          title: `Add a ${s(args.kind) || 'door'}`,
          spotlight: (p) => [p.openings[p.openings.length - 1]?.id ?? ''],
        }),
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
        mutate('edit_opening', RUNNERS.edit_opening!(args), {
          title: 'Edit an opening',
          spotlight: () => [s(args.opening_id)],
        }),
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
        mutate('add_furniture', RUNNERS.add_furniture!(args), {
          title: `Place ${s(args.type)}`,
          spotlight: (p) => [p.furniture[p.furniture.length - 1]?.id ?? ''],
        }),
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
        mutate('edit_furniture', RUNNERS.edit_furniture!(args), {
          title: `Move ${s(args.item)}`,
          spotlight: (p) => [findFurniture(p, s(args.item))?.id ?? ''],
        }),
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
        mutate('furnish_room', RUNNERS.furnish_room!(args), { title: `Furnish ${s(args.room)}` }),
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
        mutate('delete_entity', RUNNERS.delete_entity!(args), {
          destructive: true,
          title: `Delete ${s(args.kind)} "${s(args.reference)}"`,
        }),
    },

    {
      name: 'clear_room',
      description: 'Take every piece of furniture out of one room, leaving the shell. Asks for confirmation.',
      annotations: { title: 'Empty a room', readOnlyHint: false, destructiveHint: true },
      inputSchema: obj({ room: ROOM_REF }, ['room']),
      execute: (args) =>
        mutate('clear_room', RUNNERS.clear_room!(args), {
          destructive: true,
          title: `Empty ${s(args.room)}`,
        }),
    },

    {
      name: 'edit_plan',
      description:
        'Rename the drawing, or change the standards it is measured against — the body diameter used for circulation, the turning circle, the minimum clear doorway, and how thick the walls are. Raise the standards to design for a wheelchair user; lower them to check an existing home against a walking frame.',
      annotations: { title: 'Rename or re-standardise the plan', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj({
        name: { type: 'string', description: 'What to call this drawing.' },
        mobility_diameter_mm: { type: 'number', description: 'Body width used for circulation. 900 mm is the wheelchair default; 700 mm is a walking frame.' },
        turning_circle_mm: { type: 'number', description: 'Clear circle required in key rooms. 1500 mm is standard.' },
        min_clear_door_mm: { type: 'number', description: 'Minimum clear doorway. 815 mm is the usual figure.' },
        interior_wall_mm: { type: 'number', description: 'Thickness of internal partitions. 100 mm by default.' },
        exterior_wall_mm: { type: 'number', description: 'Thickness of the outside envelope. 250 mm by default.' },
      }),
      execute: (args) =>
        mutate('edit_plan', RUNNERS.edit_plan!(args), {
          title: s(args.name) ? `Rename the plan to "${s(args.name)}"` : 'Change the standards this plan is checked against',
        }),
    },

    {
      name: 'apply_batch',
      description:
        'Apply several edits as ONE atomic change with a single approval. Use this whenever a task needs more than one step — designing a room, fixing a list of findings, furnishing a flat — instead of asking the person to approve each edit separately. If any step is rejected, nothing is applied and you are told which step failed and why.',
      annotations: { title: 'Apply a set of changes', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj(
        {
          intent: {
            type: 'string',
            description:
              'One sentence saying what this batch is for. It is the heading the person sees on the approval card, so write it for them.',
          },
          operations: {
            type: 'array',
            description: 'The steps, applied in order.',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: OPERATION_NAMES,
                  description: 'Which operation to run.',
                },
                args: {
                  type: 'object',
                  description: 'Exactly the arguments the standalone tool of that name takes.',
                },
              },
              required: ['op', 'args'],
              additionalProperties: false,
            },
          },
        },
        ['intent', 'operations'],
      ),
      execute: (args) => {
        const intent = s(args.intent) || 'A set of changes';
        const raw = Array.isArray(args.operations) ? (args.operations as unknown[]) : [];
        const steps = raw.map((entry) => {
          const e = (entry ?? {}) as { op?: unknown; args?: unknown };
          return { op: s(e.op), args: (e.args ?? {}) as ArgMap };
        });
        if (steps.length === 0) {
          return replyError('No operations were given.', {
            hint: `Pass an operations array. Available: ${OPERATION_NAMES.join(', ')}.`,
          });
        }
        return mutate(
          'apply_batch',
          (draft) => {
            const schemas = new Map(buildTools().map((t) => [t.name, t.inputSchema as ToolSchema]));
            const result = runBatch(draft, steps, (op, opArgs) => {
              const schema = schemas.get(op);
              return schema ? validateArgs(op, schema, opArgs) : null;
            });
            if (!result.ok) return { ok: false, error: result.error, hint: result.hint };
            return {
              ok: true,
              value: null,
              message: `${intent} — ${result.messages.join(' ')}`,
            };
          },
          { title: intent },
        );
      },
    },

    {
      name: 'undo',
      description:
        'Step the drawing backwards or forwards through its history, whoever made the changes. Use it when the person says an edit was wrong, or asks you to put something back. The history is shared, so this undoes their edits as readily as your own — say what you are about to roll back before you do it.',
      annotations: { title: 'Undo or redo', readOnlyHint: false, destructiveHint: false },
      inputSchema: obj({
        steps: { type: 'number', description: 'How many changes to step through. Default 1.' },
        direction: { type: 'string', enum: ['undo', 'redo'], description: 'Default undo.' },
      }),
      execute: (args) => {
        const direction = s(args.direction) === 'redo' ? 'redo' : 'undo';
        const wanted = Math.max(1, Math.min(50, Math.round(num(args.steps, 1)!)));
        let done = 0;
        while (done < wanted && (direction === 'undo' ? store.undo() : store.redo())) done += 1;
        if (done === 0) {
          return replyError(
            direction === 'undo' ? 'There is nothing left to undo.' : 'There is nothing to redo.',
            { hint: 'Call get_activity to see what has happened so far.' },
          );
        }
        note('undo', `${direction} ${done} step(s).`);
        const a = analyse(store.plan);
        return reply({
          ok: true,
          summary: `Stepped ${direction === 'undo' ? 'back' : 'forward'} ${done} change${done === 1 ? '' : 's'}${
            done < wanted ? `, which was as far as the history goes` : ''
          }.`,
          steps_taken: done,
          remaining_errors: a.stats.errorCount,
          plan_score: a.stats.score,
        });
      },
    },

    {
      name: 'load_sample',
      description:
        'Replace the whole drawing: "apartment" is a furnished two-bedroom flat with real problems in it, "accessible" a bungalow that passes every rule (a worked example to copy from), "shell" an empty 48 m² box, and "blank" a completely empty page to design a home from nothing. Asks for confirmation because it discards the current plan.',
      annotations: { title: 'Load a starter plan', readOnlyHint: false, destructiveHint: true },
      inputSchema: obj(
        {
          which: { type: 'string', enum: ['apartment', 'accessible', 'shell', 'blank'] },
          name: { type: 'string', description: 'What to call the new drawing. Blank pages default to "Untitled plan".' },
        },
        ['which'],
      ),
      execute: (args) =>
        mutate(
          'load_sample',
          (draft) => {
            const which = s(args.which);
            if (which === 'blank') {
              draft.name = s(args.name) || 'Untitled plan';
              draft.rooms = [];
              draft.openings = [];
              draft.furniture = [];
              store.requestFit();
              return { ok: true, value: null, message: `Started a blank page called "${draft.name}".` };
            }
            const next = which === 'shell' ? shellPlan() : which === 'accessible' ? accessiblePlan() : starterPlan();
            draft.name = s(args.name) || next.name;
            draft.rooms = next.rooms;
            draft.openings = next.openings;
            draft.furniture = next.furniture;
            draft.settings = next.settings;
            store.requestFit();
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
          .map((r) => findEntity(store.plan, r)?.id ?? findOpening(store.plan, r)?.id ?? null)
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
      name: 'show_route',
      description:
        'Play the journey from the front door into a room on the drawing. A body of the given width travels the widest route the home allows and stops, at full scale, exactly where it stops fitting — with the measurement labelled on the spot. Use this whenever someone asks why a room is unreachable, or wants to see whether a wider wheelchair would still get through: showing them beats quoting a number at them.',
      annotations: { title: 'Show the route', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: obj(
        {
          to_room: ROOM_REF,
          body_diameter_mm: {
            type: 'number',
            description:
              'Width of the body making the trip, mm. Defaults to the plan setting (900 mm). 700 mm is a walking frame; 1000 mm is a large powered chair.',
          },
        },
        ['to_room'],
      ),
      execute: (args) => {
        const plan = store.plan;
        const room = findRoom(plan, s(args.to_room));
        if (!room) {
          return replyError(`No room called "${s(args.to_room)}".`, {
            hint: `Rooms in this plan: ${roomNames(plan)}.`,
          });
        }
        const diameter = Math.round(num(args.body_diameter_mm, plan.settings.mobilityRadius * 2)!);
        const journey = planJourney(plan, analyse(plan).grid, room.id, diameter / 2);
        if (!journey) {
          return replyError(`Nothing connects the entrance to "${room.name}" at all.`, {
            hint: 'Check there is a front door, and that the room has a door onto the rest of the plan.',
          });
        }
        store.play(journey);
        note('show_route', describeJourney(journey, diameter));
        return reply({
          ok: true,
          summary: describeJourney(journey, diameter),
          playing_on_screen: true,
          reaches: journey.arrives,
          tested_diameter_mm: diameter,
          route_width_mm: journey.widthMm,
          distance_m: Math.round(journey.distanceMm / 100) / 10,
          rooms_passed: journey.rooms,
          stops_at: journey.pinch,
        });
      },
    },

    {
      name: 'edit_underlay',
      description:
        'Adjust the reference picture the user is tracing over: set how wide it really is, nudge it into position, fade it, or lock it so the mouse goes back to the drawing. Use it when someone says the traced image is the wrong size or out of line. It does not change the plan itself.',
      annotations: { title: 'Adjust the tracing image', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: obj({
        real_width_m: { type: 'number', description: 'How wide the picture is in the real world, metres.' },
        dx_mm: { type: 'number', description: 'Nudge east, mm.' },
        dy_mm: { type: 'number', description: 'Nudge south, mm.' },
        opacity: { type: 'number', description: 'Between 0.1 and 1.' },
        locked: { type: 'boolean', description: 'True to fix it in place so the drawing takes the mouse.' },
      }),
      execute: (args) => {
        const under = store.underlay;
        if (!under) {
          return replyError('There is no tracing image loaded.', {
            hint: 'The person can add one with "Trace an image" in the bottom bar, or by dropping a picture onto the page.',
          });
        }
        let next = { ...under };
        const changed: string[] = [];
        const width = num(args.real_width_m);
        if (width !== undefined && width > 0.5) {
          next = rescale(next, Math.round(width * 1000));
          changed.push(`width ${width} m`);
        }
        if (args.dx_mm !== undefined || args.dy_mm !== undefined) {
          next.x += Math.round(num(args.dx_mm, 0)!);
          next.y += Math.round(num(args.dy_mm, 0)!);
          changed.push('position');
        }
        const opacity = num(args.opacity);
        if (opacity !== undefined) {
          next.opacity = Math.max(0.1, Math.min(1, opacity));
          changed.push(`fade ${Math.round(next.opacity * 100)}%`);
        }
        if (typeof args.locked === 'boolean') {
          next.locked = args.locked;
          changed.push(args.locked ? 'locked' : 'unlocked');
        }
        if (changed.length === 0) {
          return replyError('Nothing to change.', {
            hint: 'Pass real_width_m, dx_mm/dy_mm, opacity or locked.',
          });
        }
        store.setUnderlay(next);
        note('edit_underlay', changed.join(', '));
        return reply({
          ok: true,
          summary: `Tracing image updated: ${changed.join(', ')}.`,
          image: { x_mm: next.x, y_mm: next.y, width_mm: next.width, height_mm: next.height, locked: next.locked },
        });
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
        grid: { type: 'boolean', description: 'Show the metric grid.' },
        fit: { type: 'boolean', description: 'Zoom the drawing so the whole plan is visible.' },
        select: {
          type: 'string',
          description:
            'Select a room, opening or item of furniture, as the person would by clicking it. Pass an empty string to deselect.',
        },
      }),
      execute: (args) => {
        const changed: string[] = [];
        for (const key of ['heatmap', 'reach', 'swings', 'approach', 'dimensions', 'grid'] as const) {
          if (typeof args[key] === 'boolean') {
            store.overlays[key] = args[key] as boolean;
            changed.push(`${key}=${args[key]}`);
          }
        }
        if (args.select !== undefined) {
          const ref = s(args.select);
          if (!ref) {
            store.select(null);
            changed.push('selection cleared');
          } else {
            const found = findEntity(store.plan, ref);
            if (!found) {
              return replyError(`Nothing on the plan matches "${ref}".`, {
                hint: `Rooms in this plan: ${roomNames(store.plan)}. Furniture and openings can be given by label or id from get_plan.`,
              });
            }
            store.select({ kind: found.kind, id: found.id });
            changed.push(`selected ${found.label}`);
          }
        }
        if (args.fit === true) {
          store.requestFit();
          changed.push('fitted the drawing');
        }
        if (changed.length === 0) {
          return replyError('Nothing to change.', {
            hint: 'Pass one or more of heatmap, reach, swings, approach, dimensions, grid, fit or select.',
          });
        }
        store.emit();
        note('set_view', changed.join(', '));
        return reply({
          ok: true,
          summary: `View updated: ${changed.join(', ')}.`,
          overlays: store.overlays,
          selection: store.selection,
        });
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
  // The cached run, not a fresh one: buildTools is called on every state change,
  // and rasterising the whole plan per mouse-move would be absurd.
  const analysis = store.analysis;

  const proposalHolds = Boolean(store.proposal);
  if (
    analysis.violations.length > 0 &&
    store.mode !== 'review' &&
    (!proposalHolds || store.proposal?.tool === 'fix_violation' || store.agentBusy === 'fix_violation')
  ) {
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
        mutate('fix_violation', RUNNERS.fix_violation!(args), { title: `Repair: ${s(args.rule)}` }),
    });
  }

  if (store.selection && store.mode !== 'review' && !proposalHolds) {
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
/**
 * Wraps a tool so its arguments are checked before anything runs.
 *
 * The Model Context host passes whatever the model sent straight through, so
 * without this an agent that asks for an L-shaped room gets a rectangle and no
 * hint that half its request evaporated. Silently doing nearly the right thing
 * is worse than refusing.
 */
function guarded(spec: ToolSpec): ToolSpec {
  return {
    ...spec,
    execute: (args) => {
      const problem = validateArgs(spec.name, spec.inputSchema as ToolSchema, args);
      if (!problem) return spec.execute(args);
      store.note(spec.name, 'agent', `Refused: ${problem.error}`, spec.name);
      return replyError(problem.error, {
        hint: problem.hint,
        accepted_arguments: listProperties(spec.inputSchema as ToolSchema),
      });
    },
  };
}

export function buildTools(): ToolSpec[] {
  const tools = [...readTools(), ...viewTools()];
  if (store.mode !== 'review') {
    if (!store.proposal) {
      tools.push(...writeTools());
    } else {
      // One exception to the withdrawal: the call that raised the proposal is
      // still running, waiting on the promise the gate handed it. Unregistering
      // it would abort that call and the person's decision would go nowhere.
      const live = new Set([store.proposal.tool, store.agentBusy].filter(Boolean) as string[]);
      tools.push(...writeTools().filter((t) => live.has(t.name)));
    }
  }
  tools.push(...contextualTools());
  return tools.map(guarded);
}

/** Tools that must survive a re-sync because a call is in flight through them. */
export function inFlightTools(): string[] {
  return [store.agentBusy, store.proposal?.tool].filter((x): x is string => Boolean(x));
}

let pending = 0;
let lastNames = '';

/**
 * Keeps registration in step with the state.
 *
 * Cosmetic changes — a description that now lists different rule ids — are
 * coalesced, because they arrive on every mouse-move during a drag. A change to
 * *which* tools exist is applied at once: an agent that has just had a proposal
 * approved should not be told for another quarter of a second that `undo`
 * does not exist, and a debounce that keeps being reset by a busy conversation
 * would do exactly that.
 */
export function wireTools(): void {
  const sync = () => {
    const desired = buildTools();
    const names = desired.map((t) => t.name).join(',');
    window.clearTimeout(pending);
    if (names !== lastNames) {
      lastNames = names;
      void host.sync(desired, inFlightTools());
      return;
    }
    pending = window.setTimeout(() => void host.sync(buildTools(), inFlightTools()), 60);
  };
  store.subscribe(sync);
  sync();
}

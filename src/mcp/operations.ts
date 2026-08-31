/**
 * Arguments in, plan mutation out.
 *
 * One place where a tool's arguments become a change to the drawing. Both the
 * individual write tools and `apply_batch` dispatch through this map, so a
 * batched `edit_room` behaves identically to a standalone one — same
 * validation, same wording when it refuses.
 */

import { applyFix, findViolation } from '../core/fixes';
import {
  addFurniture,
  addOpening,
  addRoom,
  clearRoom,
  deleteFurniture,
  deleteOpening,
  deleteRoom,
  findFurniture,
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
  type OpResult,
} from '../core/ops';
import { analyse } from '../core/rules';
import type { Plan, RoomType, Side } from '../core/types';

export type Runner = (draft: Plan) => OpResult<unknown>;
export type ArgMap = Record<string, unknown>;

/** Tool arguments arrive untyped; these two keep the coercion in one place. */
export const s = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown, fallback?: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export const RUNNERS: Record<string, (args: ArgMap) => Runner> = {
  add_room: (args) => (draft) =>
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

  edit_room: (args) => (draft) => {
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
      return {
        ok: false,
        error: 'Nothing to change.',
        hint: 'Pass at least one of width_mm, depth_mm, dx_mm, dy_mm, name or type.',
      };
    }
    return { ok: true, value: null, message: messages.join(' ') };
  },

  add_opening: (args) => (draft) =>
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

  edit_opening: (args) => (draft) => {
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
    if (messages.length === 0) {
      return { ok: false, error: 'Nothing to change.', hint: 'Pass width_mm, offset_mm or swing.' };
    }
    return { ok: true, value: null, message: messages.join(' ') };
  },

  add_furniture: (args) => (draft) =>
    addFurniture(draft, {
      type: s(args.type),
      roomRef: s(args.room),
      againstSide: (s(args.against_side) as Side) || undefined,
      xMm: num(args.x_mm),
      yMm: num(args.y_mm),
      rot: num(args.rotation_deg) as 0 | 90 | 180 | 270 | undefined,
      label: s(args.label) || undefined,
    }),

  edit_furniture: (args) => (draft) => {
    const ref = s(args.item);
    const f = findFurniture(draft, ref);
    if (!f) {
      return { ok: false, error: `No furniture called "${ref}".`, hint: 'Call get_plan for the list.' };
    }
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
    if (messages.length === 0) {
      return { ok: false, error: 'Nothing to change.', hint: 'Pass x_mm/y_mm, dx_mm/dy_mm or rotation_deg.' };
    }
    return { ok: true, value: null, message: messages.join(' ') };
  },

  furnish_room: (args) => (draft) =>
    furnishRoom(
      draft,
      s(args.room),
      Array.isArray(args.extra_items) ? (args.extra_items as unknown[]).map(String) : [],
    ),

  delete_entity: (args) => (draft) => {
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

  clear_room: (args) => (draft) => clearRoom(draft, s(args.room)),

  set_standards: (args) => (draft) =>
    setSettings(draft, {
      ...(args.mobility_diameter_mm !== undefined
        ? { mobilityRadius: Math.round(num(args.mobility_diameter_mm, 900)! / 2) }
        : {}),
      ...(args.turning_circle_mm !== undefined
        ? { turningCircle: num(args.turning_circle_mm, 1500)! }
        : {}),
      ...(args.min_clear_door_mm !== undefined
        ? { minClearDoor: num(args.min_clear_door_mm, 815)! }
        : {}),
    }),

  fix_violation: (args) => (draft) => {
    const target = findViolation(
      analyse(draft).violations,
      s(args.rule),
      s(args.entity) || undefined,
      draft,
    );
    if (!target) {
      return {
        ok: false,
        error: `Nothing currently fails rule "${s(args.rule)}".`,
        hint: 'Call check_plan for the live list.',
      };
    }
    const outcome = applyFix(draft, target);
    if (!outcome.applied) {
      return { ok: false, error: outcome.reason ?? 'That finding has no automatic repair.', hint: target.fix };
    }
    return { ok: true, value: null, message: `${target.title} — ${outcome.actions.join(' ')}` };
  },
};

export const OPERATION_NAMES = Object.keys(RUNNERS);

/**
 * Runs a whole sequence against one draft. Any failure aborts the lot — the
 * caller throws the draft away — so a batch is genuinely atomic and an agent
 * never lands half a change.
 */
export function runBatch(
  draft: Plan,
  operations: { op: string; args: ArgMap }[],
): { ok: true; messages: string[] } | { ok: false; error: string; hint: string } {
  const messages: string[] = [];
  for (const [i, entry] of operations.entries()) {
    const make = RUNNERS[entry.op];
    if (!make) {
      return {
        ok: false,
        error: `Step ${i + 1}: there is no operation called "${entry.op}".`,
        hint: `Available operations: ${OPERATION_NAMES.join(', ')}.`,
      };
    }
    const result = make(entry.args ?? {})(draft);
    if (!result.ok) {
      return {
        ok: false,
        error: `Step ${i + 1} (${entry.op}) failed: ${result.error}`,
        hint: `${result.hint ?? ''} Nothing was applied — the batch is all or nothing, so fix this step and send the whole sequence again.`.trim(),
      };
    }
    messages.push(result.message);
  }
  return { ok: true, messages };
}

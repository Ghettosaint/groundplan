/**
 * The consent gate.
 *
 * A tool call that would change the drawing does not change it. It builds the
 * result as a *draft*, puts it on screen next to the live plan, and blocks on
 * the promise this module hands back until a person clicks Approve or Discard.
 *
 * WebMCP makes this possible in a way a server-side MCP endpoint cannot: the
 * agent is operating inside the page the user is already looking at, so the
 * confirmation can be the real UI, with the real geometry, rather than a
 * paraphrase of the change in a chat bubble.
 */

import { analyse } from '../core/rules';
import { store, uid, type Proposal } from '../core/store';
import type { Plan } from '../core/types';

/** How long a tool waits for a human before giving up, ms. */
const APPROVAL_TIMEOUT = 180_000;

export interface ApprovalRequest {
  title: string;
  summary: string;
  changes: string[];
  next: Plan;
  tool: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  reason: string;
}

export function requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
  // A second request while one is pending replaces it — the agent should never
  // be able to stack up dialogs faster than a person can read them.
  if (store.proposal) {
    store.proposal.resolve(false, 'Superseded by a newer proposal.');
  }

  return new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    const finish = (approved: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (store.proposal?.id === proposal.id) {
        store.proposal = null;
        store.emit();
      }
      resolve({ approved, reason });
    };

    const proposal: Proposal = {
      id: uid('prop'),
      title: req.title,
      summary: req.summary,
      tool: req.tool,
      next: req.next,
      changes: req.changes,
      created: Date.now(),
      resolve: (approved, note) =>
        finish(
          approved,
          approved
            ? 'Approved by the person at the keyboard.'
            : (note ?? 'Declined by the person at the keyboard.'),
        ),
    };

    const timer = setTimeout(
      () => finish(false, 'Nobody responded within three minutes, so the change was dropped.'),
      APPROVAL_TIMEOUT,
    );

    store.proposal = proposal;
    store.note(`Awaiting approval: ${req.title}`, 'agent', req.summary, req.tool);
    store.emit();
  });
}

/** Rough count of what a draft changes, used to describe a proposal. */
export function describeDelta(before: Plan, after: Plan): string[] {
  const out: string[] = [];
  const roomsBefore = new Map(before.rooms.map((r) => [r.id, r]));
  const roomsAfter = new Map(after.rooms.map((r) => [r.id, r]));
  for (const [id, r] of roomsAfter) {
    const prev = roomsBefore.get(id);
    if (!prev) out.push(`Add room "${r.name}" (${r.w} × ${r.h} mm)`);
    else if (prev.w !== r.w || prev.h !== r.h)
      out.push(`Resize "${r.name}" ${prev.w}×${prev.h} → ${r.w}×${r.h} mm`);
    else if (prev.x !== r.x || prev.y !== r.y) out.push(`Move "${r.name}"`);
    else if (prev.name !== r.name) out.push(`Rename "${prev.name}" → "${r.name}"`);
    else if (prev.type !== r.type) out.push(`"${r.name}" becomes a ${r.type}`);
  }
  for (const [id, r] of roomsBefore) if (!roomsAfter.has(id)) out.push(`Delete room "${r.name}"`);

  const opsBefore = new Map(before.openings.map((o) => [o.id, o]));
  const opsAfter = new Map(after.openings.map((o) => [o.id, o]));
  const roomName = (id: string) => after.rooms.find((r) => r.id === id)?.name ?? 'a room';
  for (const [id, o] of opsAfter) {
    const prev = opsBefore.get(id);
    if (!prev) out.push(`Add a ${o.width} mm ${o.kind} to ${roomName(o.roomId)}`);
    else if (prev.width !== o.width)
      out.push(`Widen ${o.kind} in ${roomName(o.roomId)}: ${prev.width} → ${o.width} mm`);
    else if (prev.offset !== o.offset) out.push(`Slide ${o.kind} in ${roomName(o.roomId)}`);
    else if (prev.swing !== o.swing) out.push(`Reverse the door swing in ${roomName(o.roomId)}`);
  }
  for (const [id, o] of opsBefore)
    if (!opsAfter.has(id)) out.push(`Remove a ${o.kind} from ${roomName(o.roomId)}`);

  const furBefore = new Map(before.furniture.map((f) => [f.id, f]));
  const furAfter = new Map(after.furniture.map((f) => [f.id, f]));
  for (const [id, f] of furAfter) {
    const prev = furBefore.get(id);
    if (!prev) out.push(`Place ${f.label.toLowerCase()}`);
    else if (prev.cx !== f.cx || prev.cy !== f.cy || prev.rot !== f.rot)
      out.push(`Move ${f.label.toLowerCase()}`);
  }
  for (const [id, f] of furBefore) if (!furAfter.has(id)) out.push(`Remove ${f.label.toLowerCase()}`);

  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    out.push('Change the accessibility standards this plan is checked against');

  return out;
}

export interface IssueDelta {
  before: number;
  after: number;
  resolved: string[];
  introduced: string[];
}

const key = (v: { rule: string; entities: string[] }) => `${v.rule}|${v.entities.join(',')}`;

/**
 * What a change did to the rule findings. Returning this from every mutating
 * tool is what lets an agent tell "I moved the sofa" from "I moved the sofa and
 * it worked", without a second round trip.
 */
export function issueDelta(before: Plan, after: Plan): IssueDelta {
  const a = analyse(before).violations;
  const b = analyse(after).violations;
  const aKeys = new Map(a.map((v) => [key(v), v]));
  const bKeys = new Map(b.map((v) => [key(v), v]));
  return {
    before: a.length,
    after: b.length,
    resolved: [...aKeys].filter(([k]) => !bKeys.has(k)).map(([, v]) => v.title),
    introduced: [...bKeys].filter(([k]) => !aKeys.has(k)).map(([, v]) => v.title),
  };
}

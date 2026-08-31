/**
 * Regenerates the drawings used in the README, using the app's own SVG
 * exporter. Run with `npm run docs:render` after changing the samples, the
 * renderer or the placement rules, so the pictures in the repo cannot drift
 * from the code.
 *
 * The third drawing is not a hand-made sample at all: it is produced by
 * replaying the exact sequence of tool calls an agent makes when asked to
 * design a one-bedroom flat for a wheelchair user, through the same operation
 * dispatcher the live tools use.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyse } from '../src/core/rules';
import { accessiblePlan, emptyPlan, starterPlan } from '../src/core/samples';
import { planToSvg } from '../src/core/svg';
import type { Plan } from '../src/core/types';
import { runBatch } from '../src/mcp/operations';

const out = join(process.cwd(), 'docs');
mkdirSync(out, { recursive: true });

function render(name: string, plan: Plan, annotate: boolean): void {
  const analysis = analyse(plan);
  const svg = planToSvg(plan, { analysis, annotate, approach: false });
  writeFileSync(join(out, `${name}.svg`), `${svg}\n`, 'utf8');
  console.log(
    `${name}.svg — ${analysis.stats.errorCount} error(s), ${analysis.stats.warningCount} warning(s), score ${analysis.stats.score}`,
  );
}

/** The tool calls an agent makes for "design me a flat for a wheelchair user". */
function agentDesignedFlat(): Plan {
  const plan = emptyPlan('Designed by an agent, approved once');
  const result = runBatch(plan, [
    { op: 'add_room', args: { type: 'hall', name: 'Hall', width_mm: 7600, depth_mm: 1600 } },
    { op: 'add_room', args: { type: 'living', name: 'Living room', width_mm: 4400, depth_mm: 4400, against_room: 'Hall', against_side: 'n' } },
    { op: 'add_room', args: { type: 'kitchen', name: 'Kitchen', width_mm: 3200, depth_mm: 4400, against_room: 'Hall', against_side: 'n', align_mm: 4400 } },
    { op: 'add_room', args: { type: 'bedroom', name: 'Bedroom', width_mm: 4400, depth_mm: 3800, against_room: 'Hall', against_side: 's' } },
    { op: 'add_room', args: { type: 'bathroom', name: 'Wet room', width_mm: 3200, depth_mm: 3800, against_room: 'Hall', against_side: 's', align_mm: 4400 } },
    { op: 'add_opening', args: { room: 'Hall', kind: 'door', side: 'w', exterior: true, width_mm: 1000 } },
    { op: 'add_opening', args: { room: 'Living room', kind: 'archway', to_room: 'Hall', width_mm: 1800 } },
    { op: 'add_opening', args: { room: 'Kitchen', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
    { op: 'add_opening', args: { room: 'Bedroom', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
    { op: 'add_opening', args: { room: 'Wet room', kind: 'door', to_room: 'Hall', width_mm: 1000 } },
    { op: 'add_opening', args: { room: 'Living room', kind: 'window', exterior: true, side: 'n', width_mm: 2400 } },
    { op: 'add_opening', args: { room: 'Kitchen', kind: 'window', exterior: true, side: 'n', width_mm: 1600 } },
    { op: 'add_opening', args: { room: 'Bedroom', kind: 'window', exterior: true, side: 's', width_mm: 2400 } },
    { op: 'furnish_room', args: { room: 'Living room' } },
    { op: 'furnish_room', args: { room: 'Kitchen' } },
    { op: 'furnish_room', args: { room: 'Bedroom' } },
    { op: 'furnish_room', args: { room: 'Wet room' } },
  ]);
  if (!result.ok) throw new Error(result.error);
  return plan;
}

render('flat-with-faults', starterPlan(), true);
render('accessible-bungalow', accessiblePlan(), true);
render('agent-designed-flat', agentDesignedFlat(), true);

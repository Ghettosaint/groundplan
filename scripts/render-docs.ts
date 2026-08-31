/**
 * Regenerates the drawings used in the README, using the app's own SVG
 * exporter. Run with `npm run docs:render` after changing the samples or the
 * renderer, so the pictures in the repo cannot drift from the code.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyse } from '../src/core/rules';
import { accessiblePlan, starterPlan } from '../src/core/samples';
import { planToSvg } from '../src/core/svg';
import type { Plan } from '../src/core/types';

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

render('flat-with-faults', starterPlan(), true);
render('accessible-bungalow', accessiblePlan(), true);

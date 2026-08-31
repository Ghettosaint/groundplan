import { describe, expect, it } from 'vitest';

import { analyse } from '../src/core/rules';
import { accessiblePlan } from '../src/core/samples';

describe('the accessible bungalow', () => {
  const analysis = analyse(accessiblePlan());

  it('passes every rule', () => {
    const problems = analysis.violations.filter((v) => v.severity !== 'info');
    expect(
      problems.map((v) => `${v.severity} ${v.rule}: ${v.title} — ${v.detail}`),
    ).toEqual([]);
  });

  it('is reachable end to end', () => {
    expect(analysis.stats.reachableRatio).toBeGreaterThan(0.9);
  });

  it('scores full marks', () => {
    expect(analysis.stats.score).toBe(100);
  });
});

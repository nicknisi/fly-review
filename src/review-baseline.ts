import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import type { Descriptors } from './review-brain.ts';
import { fitLogistic, predictLogistic } from './review-logistic.ts';
import { VERDICT_RULE } from './review-verdict.ts';

/**
 * Could you skip the fly and just look at the smells? This fits a logistic regression on the exact training split the
 * fly was taught (from .runs/training.json), applies the fly's own three-way vote bands to its probability, and reports
 * the two side by side on the held-out grown cases, the bundled examples, and any smelled pull requests.
 *
 *   npm run baseline
 */
type Cached = Record<string, { features: Descriptors }>;
const odors = JSON.parse(await readFile(join(ROOT, '.runs/odors.json'), 'utf8')) as Cached;
const training = JSON.parse(await readFile(join(ROOT, '.runs/training.json'), 'utf8')) as {
  results: {
    caseId: string;
    set: 'training' | 'holdout' | 'bundled';
    control: boolean;
    status: string;
    trained: { verdict: string; share: number };
    agrees: boolean | null;
  }[];
};
const model = fitLogistic(
  training.results
    .filter(r => r.set === 'training')
    .map(r => ({ features: odors[r.caseId].features, regression: !r.control })),
);
const verdict = (p: number) =>
  p >= VERDICT_RULE.objection ? 'changes_requested' : p <= VERDICT_RULE.approval ? 'no_objection' : 'abstain';

const sets = {} as Record<string, unknown>;
for (const set of ['holdout', 'bundled', 'training'] as const) {
  const rows = training.results.filter(r => r.set === set);
  const scored = rows.map(r => {
    const p = predictLogistic(model, odors[r.caseId].features);
    const expected = r.control ? 'no_objection' : 'changes_requested';
    return { ...r, logistic: { p, verdict: verdict(p), agrees: verdict(p) === expected } };
  });
  const tally = (pick: (r: (typeof scored)[number]) => string) => ({
    agree: scored.filter(r => pick(r) === (r.control ? 'no_objection' : 'changes_requested')).length,
    regressionsCaught: `${scored.filter(r => !r.control && pick(r) === 'changes_requested').length}/${scored.filter(r => !r.control).length}`,
    controlsApproved: `${scored.filter(r => r.control && pick(r) === 'no_objection').length}/${scored.filter(r => r.control).length}`,
    falseAlarms: scored.filter(r => r.control && pick(r) === 'changes_requested').length,
    abstained: scored.filter(r => pick(r) === 'abstain').length,
  });
  const fly = tally(r => r.trained.verdict),
    logistic = tally(r => r.logistic.verdict);
  sets[set] = { judged: rows.length, fly, logistic };
  console.log(
    `${set.padEnd(9)} fly ${fly.agree}/${rows.length} (regressions ${fly.regressionsCaught}, controls ${fly.controlsApproved}, false alarms ${fly.falseAlarms})   logistic ${logistic.agree}/${rows.length} (regressions ${logistic.regressionsCaught}, controls ${logistic.controlsApproved}, false alarms ${logistic.falseAlarms})`,
  );
}
const strongest = Object.entries(model.weights)
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .slice(0, 6);
console.log(`strongest weights: ${strongest.map(([k, w]) => `${k} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`).join(', ')}`);

let pulls: unknown[] = [];
try {
  const prs = JSON.parse(await readFile(join(ROOT, '.runs/pr-odors.json'), 'utf8')) as Record<
    string,
    { features: Descriptors }
  >;
  pulls = Object.entries(prs).map(([pr, e]) => {
    const p = predictLogistic(model, e.features);
    console.log(`${pr.padEnd(28)} logistic p(regression) ${p.toFixed(2)} ${verdict(p)}`);
    return { pr, p, verdict: verdict(p) };
  });
} catch {
  /* no pull requests smelled yet */
}
await atomicJSON(join(ROOT, '.runs/baseline.json'), {
  at: new Date().toISOString(),
  note: 'Logistic regression over the thirty descriptors, fit on the same training split as the fly, judged with the fly’s vote bands. The fly column is copied from .runs/training.json.',
  model,
  strongest,
  sets,
  pulls,
});
console.log('Evidence: .runs/baseline.json');

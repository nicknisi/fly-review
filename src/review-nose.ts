import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import type { Descriptors } from './review-brain.ts';
import { REVIEW_CASES, changedText } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { loadGrownCases } from './review-grown.ts';
import { fitLogistic, predictLogistic } from './review-logistic.ts';
import { loadMinedCases } from './review-mined.ts';
import { GLOMERULI, LIVE_NOSE, NOSES, odorKey, odorize } from './review-odor.ts';
import type { Nose } from './review-odor.ts';

/**
 * Does the nose carry the verdict? For each nose, on the exact split the fly was trained on, measure what a trivial reader
 * gets from the same odor the fly smells: the single best glomerulus (threshold and direction fit on the training set),
 * and a logistic regression over all 53 glomeruli. If one glomerulus already separates regressions from controls, the fly
 * downstream of it is a middle-man for whatever drives that glomerulus.
 *
 * Scores are balanced accuracy, the mean of regressions caught and controls approved, because three in four held-out
 * cases are regressions and "always object" scores 78% raw. The readers here vote yes or no; the fly may abstain, which
 * counts against it.
 *
 *   npm run nose     TRAINING=.runs/training.json for the split; a fly's column is read from .runs/training[.nose-<n>].json
 */
type Row = { caseId: string; set: string; expected: string | null; trained: { verdict: string } };
const trainingPath = join(ROOT, process.env.TRAINING ?? '.runs/training.json');
const split = (JSON.parse(await readFile(trainingPath, 'utf8')) as { results: Row[] }).results.filter(
  r => r.expected !== null,
);
const odors = JSON.parse(await readFile(join(ROOT, '.runs/odors.json'), 'utf8')) as Record<
  string,
  { features: Descriptors }
>;
const cases = new Map<string, ReviewCase>(
  [...(await loadGrownCases()), ...(await loadMinedCases()), ...REVIEW_CASES].map(c => [c.id, c]),
);
const regression = (r: Row) => r.expected === 'changes_requested';
const train = split.filter(r => r.set === 'training');
const holdout = split.filter(r => r.set === 'holdout');

/** objects: true, approves: false, abstains: null. */
type Vote = (r: Row) => boolean | null;
export function balanced(rows: Row[], vote: Vote) {
  const bugs = rows.filter(regression),
    fine = rows.filter(r => !regression(r));
  const caught = bugs.filter(r => vote(r) === true).length,
    approved = fine.filter(r => vote(r) === false).length;
  return {
    balanced: Math.round(((caught / bugs.length + approved / fine.length) / 2) * 1000) / 1000,
    caught: `${caught}/${bugs.length}`,
    approved: `${approved}/${fine.length}`,
  };
}

const report: Record<string, unknown> = {};
for (const nose of NOSES) {
  const smell = new Map(
    split.map(r => {
      const odor = odorize(odors[r.caseId].features, changedText(cases.get(r.caseId)!), nose as Nose);
      return [r.caseId, Object.fromEntries(GLOMERULI.map(g => [g, (odor[odorKey(g)] ?? 0) / 150]))];
    }),
  );
  const x = (r: Row) => smell.get(r.caseId)!;

  // The answer-key test: the one glomerulus a reader could watch instead of the fly, chosen on training data only.
  let best = { glomerulus: '', threshold: 0, above: true, train: 0 };
  for (const g of GLOMERULI) {
    for (const threshold of new Set(train.map(r => x(r)[g]))) {
      for (const above of [true, false]) {
        const score = balanced(train, r => x(r)[g] >= threshold === above).balanced;
        if (score > best.train) best = { glomerulus: g, threshold, above, train: score };
      }
    }
  }
  const single = balanced(holdout, r => x(r)[best.glomerulus] >= best.threshold === best.above);

  const model = fitLogistic(
    train.map(r => ({ features: x(r), regression: regression(r) })),
    { keys: GLOMERULI },
  );
  const logistic = balanced(holdout, r => predictLogistic(model, x(r)) >= 0.5);

  let fly: ReturnType<typeof balanced> | null = null;
  try {
    const path = join(ROOT, `.runs/training${nose === LIVE_NOSE ? '' : `.nose-${nose}`}.json`);
    const rows = (JSON.parse(await readFile(path, 'utf8')) as { results: Row[] }).results.filter(
      r => r.set === 'holdout' && r.expected !== null,
    );
    fly = balanced(rows, r =>
      r.trained.verdict === 'changes_requested' ? true : r.trained.verdict === 'no_objection' ? false : null,
    );
  } catch {
    /* no fly trained through this nose yet */
  }
  report[nose] = { single: { ...best, holdout: single }, logistic, fly };
  const cell = (s: ReturnType<typeof balanced> | null) =>
    s ? `${(s.balanced * 100).toFixed(1)}% (caught ${s.caught}, approved ${s.approved})` : 'not trained';
  console.log(`\nnose ${nose}`);
  console.log(`  best single glomerulus ${best.glomerulus.padEnd(9)} ${cell(single)}`);
  console.log(`  logistic, 53 glomeruli           ${cell(logistic)}`);
  console.log(`  fly                              ${cell(fly)}`);
}
console.log(`\nheld out: ${holdout.length} cases, ${holdout.filter(regression).length} regressions; chance is 50.0%`);
await atomicJSON(join(ROOT, '.runs/nose.json'), {
  at: new Date().toISOString(),
  note: 'Balanced accuracy on the held-out split of the fly’s training run. Single glomerulus and logistic regression read the same odor the fly smells, fit on the same training cases.',
  training: trainingPath,
  report,
});

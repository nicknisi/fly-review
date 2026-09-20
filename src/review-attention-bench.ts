import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { smellSequence } from './review-brain.ts';
import type { Descriptors } from './review-brain.ts';
import { REVIEW_CASES, changedText } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { loadGrownCases } from './review-grown.ts';
import { fitLogistic, predictLogistic } from './review-logistic.ts';
import { odorize } from './review-odor.ts';

/**
 * Does the fly look at the right hunk? Synthetic diffs are assembled from executed cases: K hunks that share a smell
 * category plus one odd hunk, shuffled. The fly reads the diff hunk by hunk (smellSequence) and we ask where it looked.
 *
 * Four directions, because they separate novelty from valence. Across classes (odd regression among controls, odd
 * control among regressions) a classifier can win by scoring each hunk alone. Within a class (odd control among controls
 * of another smell category, odd regression among regressions of another category) the class is uninformative: only
 * something that notices "unlike the rest" can point at the odd one, and a classifier's best guess is the hunk whose
 * score is most atypical.
 *
 * Baselines: random (1 / hunks) and per-hunk logistic regression over the same descriptors, fit on the fly's training
 * split. Valence attention (the hunk with the highest avoidance share) is reported alongside novelty attention.
 *
 *   npm run bench:attention                TRIALS=40 K=5 MEMORY=.runs/trained-memory.json FAMILIARITY=0.3 SEED=7
 */
const trials = Number(process.env.TRIALS ?? 40);
const k = Number(process.env.K ?? 5);
const seed = Number(process.env.SEED ?? 7);
const familiarity = Number(process.env.FAMILIARITY ?? 0.3);
const memoryPath = join(ROOT, process.env.MEMORY ?? '.runs/trained-memory.json');
const DIRECTIONS = [
  'odd-regression',
  'odd-control',
  'odd-control-among-controls',
  'odd-regression-among-regressions',
] as const;
type Direction = (typeof DIRECTIONS)[number];
const directions = (process.env.DIRECTIONS?.split(',') as Direction[] | undefined)?.filter(d =>
  DIRECTIONS.includes(d),
) ?? [...DIRECTIONS];

type Cached = Record<string, { features: Descriptors }>;
const odors = JSON.parse(await readFile(join(ROOT, '.runs/odors.json'), 'utf8')) as Cached;
const training = JSON.parse(await readFile(join(ROOT, '.runs/training.json'), 'utf8')) as {
  results: { caseId: string; set: 'training' | 'holdout' | 'bundled'; control: boolean }[];
};
const taught = new Set(training.results.filter(r => r.set === 'training').map(r => r.caseId));
const all: ReviewCase[] = [...(await loadGrownCases()), ...REVIEW_CASES].filter(c => odors[c.id]);
const model = fitLogistic(
  training.results
    .filter(r => r.set === 'training')
    .map(r => ({ features: odors[r.caseId].features, regression: !r.control })),
);
const odorOf = (c: ReviewCase) => odorize(odors[c.id].features, changedText(c));

let x = seed >>> 0 || 1;
const random = () => {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
};
const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
const shuffle = <T>(list: T[]) => [...list].sort(() => random() - 0.5);

// Hunks that share a smell category stand in for the repetitive bulk of a real diff.
const bySmell = (control: boolean) => {
  const groups = new Map<string, ReviewCase[]>();
  for (const c of all)
    if (Boolean(c.control) === control && c.smell) groups.set(c.smell, [...(groups.get(c.smell) ?? []), c]);
  return [...groups.values()].filter(g => g.length >= k);
};
const controlGroups = bySmell(true),
  regressionGroups = bySmell(false);
const oddRegressions = all.filter(c => !c.control && !taught.has(c.id));
const oddControls = all.filter(c => c.control && !taught.has(c.id));
if (!controlGroups.length || !regressionGroups.length) throw new Error(`No smell category has ${k} cases; lower K`);

type Trial = {
  direction: Direction;
  hunks: string[];
  odd: number;
  novelty: number[];
  familiarity: number[];
  share: number[];
  logistic: number[];
  lookedNovelty: number;
  lookedValence: number;
  lookedLogistic: number;
};
const results: Trial[] = [];
const argmax = (values: number[]) => values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
const argmin = (values: number[]) => values.reduce((best, v, i) => (v < values[best] ? i : best), 0);
const atypical = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return argmax(values.map(v => Math.abs(v - median)));
};
const started = Date.now();
for (const direction of directions) {
  for (let t = 0; t < trials; t++) {
    const bulkIsControl = direction === 'odd-regression' || direction === 'odd-control-among-controls';
    const bulkGroup = pick(bulkIsControl ? controlGroups : regressionGroups);
    const bulk = shuffle(bulkGroup).slice(0, k);
    const oddIsControl = direction === 'odd-control' || direction === 'odd-control-among-controls';
    // Within a class the odd hunk must come from another smell category, or there is nothing to be odd about.
    const oddPool = (oddIsControl ? oddControls : oddRegressions).filter(
      c => bulkIsControl !== oddIsControl || c.smell !== bulk[0].smell,
    );
    const odd = pick(oddPool);
    const hunks = shuffle([...bulk, odd]);
    const reading = await smellSequence(hunks.map(odorOf), { seed, memoryPath, familiarity });
    const seq = reading.sequence!;
    const novelty = seq.hunks.map(h => h.noveltyHz);
    const share = seq.hunks.map(h => (h.avoidHz + h.approachHz > 0 ? h.avoidHz / (h.avoidHz + h.approachHz) : 0.5));
    const logistic = hunks.map(c => predictLogistic(model, odors[c.id].features));
    results.push({
      direction,
      hunks: hunks.map(c => c.id),
      odd: hunks.indexOf(odd),
      novelty,
      familiarity: seq.hunks.map(h => h.familiarity),
      share,
      logistic,
      lookedNovelty: seq.looked,
      // Across classes, valence attention points at the hunk that smells worst (odd regression) or best (odd control),
      // and the classifier at its most or least probable regression. Within a class neither has a direction, so each
      // points at the hunk whose score is most atypical.
      lookedValence:
        direction === 'odd-regression' ? argmax(share) : direction === 'odd-control' ? argmin(share) : atypical(share),
      lookedLogistic:
        direction === 'odd-regression'
          ? argmax(logistic)
          : direction === 'odd-control'
            ? argmin(logistic)
            : atypical(logistic),
    });
    if ((t + 1) % 10 === 0)
      console.log(`${direction}: ${t + 1}/${trials} trials (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
}

const summarize = (direction: Trial['direction']) => {
  const rows = results.filter(r => r.direction === direction);
  const hit = (pick: (r: Trial) => number) => rows.filter(r => pick(r) === r.odd).length;
  // Ties at the top of the novelty readout are common at low spike counts; count a tie as a miss, but report it.
  const tiedTop = rows.filter(r => r.novelty.filter(v => v === Math.max(...r.novelty)).length > 1).length;
  return {
    trials: rows.length,
    hunks: k + 1,
    random: `${(rows.length / (k + 1)).toFixed(1)} expected`,
    noveltyAttention: hit(r => r.lookedNovelty),
    noveltyTiesAtTop: tiedTop,
    valenceAttention: hit(r => r.lookedValence),
    logisticPerHunk: hit(r => r.lookedLogistic),
    oddMeanNovelty: rows.reduce((s, r) => s + r.novelty[r.odd], 0) / rows.length,
    bulkMeanNovelty:
      rows.reduce((s, r) => s + r.novelty.filter((_, i) => i !== r.odd).reduce((a, b) => a + b, 0) / k, 0) /
      rows.length,
  };
};
const summary = Object.fromEntries(directions.map(d => [d, summarize(d)]));
for (const [direction, s] of Object.entries(summary))
  console.log(
    `\n${direction}: ${s.trials} diffs of ${s.hunks} hunks. Looked at the odd one: novelty ${s.noveltyAttention} (${s.noveltyTiesAtTop} ties at the top), valence ${s.valenceAttention}, per-hunk logistic ${s.logisticPerHunk}, random ${s.random}. Mean novelty: odd hunk ${s.oddMeanNovelty.toFixed(1)} Hz, bulk ${s.bulkMeanNovelty.toFixed(1)} Hz.`,
  );
await atomicJSON(join(ROOT, '.runs/attention-bench.json'), {
  at: new Date().toISOString(),
  note: 'Synthetic diffs from executed cases: K hunks sharing a smell category plus one odd hunk (from another category when it shares the class), shuffled. The fly reads each diff hunk by hunk; "looked" is the hunk whose α\'3 novelty MBONs stayed loudest on the frozen second reading. Odd hunks were never taught. Baselines on the same descriptors and split.',
  seed,
  k,
  trials,
  familiarity,
  memoryPath,
  summary,
  results,
});
console.log('\nEvidence: .runs/attention-bench.json');

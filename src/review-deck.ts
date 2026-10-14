import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { pokeBrain, smellBrain } from './review-brain.ts';
import type { ReviewBrain, ReviewFrame } from './review-brain.ts';
import { REVIEW_CASES, changedText, diffLines } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { loadGrownCases } from './review-grown.ts';
import { loadMinedCases } from './review-mined.ts';
import { LIVE_NOSE, RECEPTORS, VERDICT_RECEPTORS, odorize } from './review-odor.ts';
import type { Descriptors } from './review-brain.ts';
import { reviewVerdict } from './review-verdict.ts';
import { DEFAULT_POKE_HZ, POKE_PRESETS } from './review-pokes.ts';
import type { PokePreset } from './review-pokes.ts';

/**
 * Everything the talk deck (/presentation) shows, generated from the measured record so the slides never carry a number by
 * hand: the figures from the data files, real recordings from the simulator, and the audience-round pool from the held-out
 * split. Rerun after retraining or reinstalling the fly.
 *
 *   npm run deck      writes data/deck.json (needs the connectome and the cached Jev descriptions in .runs/odors.json)
 */
type Row = {
  caseId: string;
  set: string;
  control: boolean;
  status: string;
  expected: 'changes_requested' | 'no_objection' | null;
  smell?: string;
  corpus: string;
  trained: { verdict: string; share: number; feedHz: number; behavior: 'reached' | 'still' };
};
type Summary = {
  judged: number;
  agreeing: number;
  abstained: number;
  falseAlarms: number;
  missedAsApproved: number;
  regressionsCaught: string;
  controlsApproved: string;
  naiveAgreeing: number;
};
const read = async <T>(path: string) => JSON.parse(await readFile(join(ROOT, path), 'utf8')) as T;

const training = await read<{
  rate: number;
  passes: number;
  nose: string;
  summary: Record<string, Summary>;
  results: Row[];
}>('data/training.json');
const shuffled = await read<{ summary: Record<string, Summary> }>('data/training.shuffle-dan-mbon.neutral.json');
const nose = await read<{
  report: Record<
    string,
    {
      single: { glomerulus: string; holdout: { balanced: number } };
      logistic: { balanced: number };
      fly: { balanced: number } | null;
    }
  >;
}>('data/nose.json');
const baseline = await read<{ sets: Record<string, { judged: number; logistic: { agree: number } }> }>(
  'data/baseline.json',
);
const prs = await read<{
  report: {
    pr: string;
    title: string;
    verdict: string;
    remembered: number;
    attention?: { lookedName: string; units: number; quiet: number };
  }[];
}>('data/pr-smells.json');
const odors = await read<Record<string, { features: Descriptors }>>('.runs/odors.json');
const cases = new Map<string, ReviewCase>(
  [...(await loadGrownCases()), ...(await loadMinedCases()), ...REVIEW_CASES].map(c => [c.id, c]),
);

const fraction = (s: string) => s.split('/').map(Number) as [number, number];
const balanced = (s: Summary) => {
  const [c, cn] = fraction(s.regressionsCaught),
    [a, an] = fraction(s.controlsApproved);
  return (c / cn + a / an) / 2;
};
const held = training.summary.holdout;
const numbers = {
  nose: training.nose,
  rate: training.rate,
  passes: training.passes,
  neurons: 176_422,
  connections: 6_287_749,
  kenyonCells: 4_064,
  // Kenyon cell → output neuron synapses the lessons can change (README, The memory is in the compartments).
  plasticSynapses: 31_493,
  glomeruli: 53,
  lessons: 522,
  heldOut: held.judged,
  balanced: balanced(held),
  agree: held.agreeing,
  caught: fraction(held.regressionsCaught),
  approved: fraction(held.controlsApproved),
  falseAlarms: held.falseAlarms,
  bugsApproved: held.missedAsApproved,
  abstained: held.abstained,
  votes: held.judged - held.abstained,
  naiveAgree: held.naiveAgreeing,
  bundled: { agree: training.summary.bundled.agreeing, judged: training.summary.bundled.judged },
  logisticAgree: baseline.sets.holdout.logistic.agree,
  shuffled: {
    caught: fraction(shuffled.summary.holdout.regressionsCaught),
    bugsApproved: shuffled.summary.holdout.missedAsApproved,
  },
  answerKey: Object.fromEntries(
    Object.entries(nose.report).map(([k, v]) => [
      k,
      {
        single: v.single.holdout.balanced,
        glomerulus: v.single.glomerulus,
        logistic: v.logistic.balanced,
        fly: v.fly?.balanced ?? null,
      },
    ]),
  ),
  prs: prs.report.map(p => ({
    pr: p.pr,
    title: p.title,
    verdict: p.verdict,
    share: p.remembered,
    looked: p.attention?.lookedName ?? null,
  })),
};

// Real runs of the simulator, stripped of the anatomy the page already has.
const strip = (b: ReviewBrain) => ({
  lesson: b.lesson,
  verdict: reviewVerdict(b).verdict,
  behavior: reviewVerdict(b).behavior,
  feedHz: b.feedHz,
  groomHz: b.groomHz,
  escapeHz: b.escapeHz,
  avoidHz: b.avoidHz,
  approachHz: b.approachHz,
  ppl1Hz: b.ppl1Hz ?? 0,
  pamHz: b.pamHz ?? 0,
  activeKenyon: b.activeKenyon,
  depressed: b.depressed,
  spikes: b.spikes,
  wallMs: b.wallMs,
  shuffle: b.shuffle ?? null,
  stimuli: b.stimuli,
  frames: b.frames.map((f: ReviewFrame) => ({
    timeMs: f.timeMs,
    feedHz: f.feedHz,
    groomHz: f.groomHz,
    escapeHz: f.escapeHz,
    avoidHz: f.avoidHz,
    approachHz: f.approachHz,
    activeKenyon: f.activeKenyon,
    spikes: f.spikes,
    ppl1Hz: f.ppl1Hz,
    pamHz: f.pamHz,
    activity3d: f.activity3d,
    readoutCounts: f.readoutCounts,
    kenyonActive3d: f.kenyonActive3d,
    mbonCounts: f.mbonCounts,
    danCounts: f.danCounts,
  })),
});
const diffOf = (c: ReviewCase) => diffLines(c.before, c.after).map(l => ({ kind: l.kind, text: l.text }));
const show = (c: ReviewCase) => ({ id: c.id, title: c.title, filename: c.filename, diff: diffOf(c) });
const odorOf = (c: ReviewCase) => odorize(odors[c.id].features, changedText(c));
const memoryPath = join(ROOT, 'data/trained-memory.json');
const bundled = training.results.filter(r => r.set === 'bundled');
const pick = (rows: Row[], score: (r: Row) => number) => [...rows].sort((a, b) => score(b) - score(a))[0];
const caught = pick(
  bundled.filter(r => !r.control && r.trained.verdict === 'changes_requested'),
  r => r.trained.share,
);
const reached = pick(
  bundled.filter(r => r.control && r.trained.behavior === 'reached'),
  r => r.trained.feedHz,
);
const missed = pick(
  bundled.filter(r => !r.control && r.trained.verdict === 'no_objection'),
  r => r.trained.feedHz,
);
const shuffleMemory = join(ROOT, '.runs/trained-memory.dan-mbon_1.neutral.json');
const scratch = await mkdtemp(join(tmpdir(), 'fly-deck-'));
const recordings: Record<string, unknown> = {};
const record = async (name: string, c: ReviewCase, options: Parameters<typeof smellBrain>[1], note: string) => {
  const brain = await smellBrain(odorOf(c), { seed: 7, ...options });
  recordings[name] = { ...strip(brain), note, review: show(c) };
  console.log(
    `${name.padEnd(10)} ${c.id.padEnd(28)} ${reviewVerdict(brain).verdict.padEnd(18)} avoid ${brain.avoidHz.toFixed(0)} approach ${brain.approachHz.toFixed(0)} MN9 ${brain.feedHz.toFixed(0)} PPL1 ${(brain.ppl1Hz ?? 0).toFixed(0)} PAM ${(brain.pamHz ?? 0).toFixed(0)}`,
  );
};
try {
  const bug = cases.get(caught.caseId)!,
    fine = cases.get(reached.caseId)!;
  await record(
    'naive',
    bug,
    { memoryPath: null },
    'An untrained fly smells a real bug: nothing learned, nothing to say.',
  );
  await record('objects', bug, { memoryPath }, 'The trained fly smells the same bug and backs away.');
  await record('reaches', fine, { memoryPath }, 'The trained fly smells a harmless change and reaches for it.');
  if (missed) await record('missed', cases.get(missed.caseId)!, { memoryPath }, 'A real bug the fly waves through.');
  await copyFile(memoryPath, join(scratch, 'bitter.json'));
  await record(
    'bitter',
    bug,
    { memoryPath: join(scratch, 'bitter.json'), lesson: 'punish' },
    'A reproduced bug: bitter on the tongue, punishment dopamine neurons fire.',
  );
  await copyFile(memoryPath, join(scratch, 'sugar.json'));
  await record(
    'sugar',
    fine,
    { memoryPath: join(scratch, 'sugar.json'), lesson: 'reward' },
    'A test-proven harmless change: sugar, reward dopamine neurons fire.',
  );
  await record(
    'scrambled',
    bug,
    { memoryPath: shuffleMemory, shuffle: 'dan-mbon:1' },
    'Same nose, same lessons, dopamine wiring scrambled.',
  );
  // Touching the fly: one real run per body part the fly model can be clicked on, so a click lights the brain at once.
  for (const preset of ['sugar', 'feet', 'antennae', 'eyes', 'brush', 'abdomen'] as PokePreset[]) {
    const brain = await pokeBrain({ [preset]: DEFAULT_POKE_HZ }, 7, 0.65, memoryPath);
    recordings[`poke-${preset}`] = {
      ...strip(brain),
      note: `${POKE_PRESETS[preset].label}: ${POKE_PRESETS[preset].population}.`,
      review: null,
    };
    console.log(
      `poke-${preset.padEnd(9)} spikes ${brain.spikes} MN9 ${brain.feedHz.toFixed(0)} DNg62 ${brain.groomHz.toFixed(0)} DNp01 ${brain.escapeHz.toFixed(0)}`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// The audience round: held-out changes short enough to read on a slide, half bugs and half harmless, with the test's
// label and the fly's vote as recorded. The deck draws three at random, live.
const changedCount = (c: ReviewCase) => diffLines(c.before, c.after).filter(l => l.kind !== 'same').length;
const readable = training.results
  .filter(r => r.set === 'holdout' && r.expected !== null)
  .map(r => ({ r, c: cases.get(r.caseId)! }))
  .filter(({ c }) => c && changedCount(c) <= 4 && c.after.split('\n').length <= 18);
let x = 7;
const random = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
const draw = (rows: typeof readable, n: number) =>
  rows
    .map(v => [v, random()] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([v]) => v);
const half = Math.min(10, readable.filter(v => v.r.control).length, readable.filter(v => !v.r.control).length);
const pool = [
  ...draw(
    readable.filter(v => !v.r.control),
    half,
  ),
  ...draw(
    readable.filter(v => v.r.control),
    half,
  ),
].map(({ r, c }) => ({
  ...show(c),
  label: r.expected === 'changes_requested' ? 'bug' : 'fine',
  smell: r.smell ?? null,
  corpus: r.corpus,
  fly: { verdict: r.trained.verdict, share: r.trained.share, behavior: r.trained.behavior },
}));

await atomicJSON(join(ROOT, 'data/deck.json'), {
  at: new Date().toISOString(),
  note: 'Generated by npm run deck from data/training.json, data/nose.json, data/baseline.json, data/pr-smells.json, data/training.shuffle-dan-mbon.neutral.json, and fresh simulator runs (seed 7) against data/trained-memory.json. Never edit by hand.',
  liveNose: LIVE_NOSE,
  numbers,
  receptors: RECEPTORS.map(r => ({
    key: r.key,
    label: r.label,
    question: r.question,
    silenced: VERDICT_RECEPTORS.includes(r.key),
  })),
  recordings,
  pool,
  poolRule: `Held-out changes with at most 4 changed lines and at most 18 lines of code: ${readable.length} qualify; ${half} bugs and ${half} harmless drawn with a fixed seed.`,
});
console.log(
  `data/deck.json: ${Object.keys(recordings).length} recordings, pool of ${pool.length} (${readable.length} readable held-out changes)`,
);

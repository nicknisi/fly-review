import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { MEMORY_PATH, reviewVerdict, smellBrain } from './review-brain.ts';
import type { Descriptors, Lesson, ReviewBrain } from './review-brain.ts';
import { REVIEW_CASES, changedText } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { loadGrownCases } from './review-grown.ts';
import { encodeWithJev } from './review-jev.ts';
import { installMemory, lessonFor, summarizeTeaching } from './review-memory.ts';
import type { LessonEntry } from './review-memory.ts';
import { odorize } from './review-odor.ts';
import { labelByExecution } from './review-verify.ts';

/**
 * Train a fresh fly on the grown corpus and test it on changes it never smelled.
 *
 * Every grown case is labeled by executing it (review-verify.ts): a reproduced regression punishes, a control the sweep
 * cannot fault rewards, anything else teaches nothing. Descriptions come from Jev once per case and are cached. A seeded
 * fifth of the corpus is held out, and the fifteen bundled examples are never taught, so both are honest tests.
 *
 *   npm run train                 teach, test, write .runs/trained-memory.json and .runs/training.json
 *   INSTALL=1 npm run train       also install the trained memory as the live fly (replaces .runs/memory.json)
 *   RATE=0.3 PASSES=1 HOLDOUT=0.2 SEED=7   (0.6 saturates a hundred lessons; 0.15 under-trains; see .runs/training.rate*.json)
 *   SHUFFLE=dan-mbon:1 npm run train        the same lessons on a connectome with one edge class rewired (degree-preserving):
 *                                           dan-mbon (which dopamine neuron reaches which MBON), kc-mbon (which Kenyon cell
 *                                           reaches which MBON), mbon-out (where MBONs project). Writes .runs/training.<spec>.json.
 */
const rate = Number(process.env.RATE ?? 0.3);
const passes = Number(process.env.PASSES ?? 1);
const holdoutShare = Number(process.env.HOLDOUT ?? 0.2);
const seed = Number(process.env.SEED ?? 7);
const shuffle = process.env.SHUFFLE || null;
/** Output suffix: the wiring ablation if any, plus TAG= for rate sweeps (e.g. TAG=rate0.6). */
const tag = [shuffle ? shuffle.replace(/[^a-z0-9-]+/g, '_') : '', process.env.TAG ?? '']
  .filter(Boolean)
  .map(t => `.${t}`)
  .join('');
const odorsPath = join(ROOT, '.runs/odors.json');
const memoryPath = join(ROOT, `.runs/trained-memory${tag}.json`);
if (shuffle && process.env.INSTALL) throw new Error('A shuffled-wiring memory must never be installed as the live fly');
await mkdir(join(ROOT, '.runs'), { recursive: true });

type Cached = Record<string, { model: string; at: string; features: Descriptors }>;
let cached: Cached = {};
try {
  cached = JSON.parse(await readFile(odorsPath, 'utf8')) as Cached;
} catch {
  /* first run */
}
const grown = await loadGrownCases();
if (grown.length === 0) throw new Error('No grown cases. Run npm run grow-cases first.');
const everything = [...grown, ...REVIEW_CASES];

// Describe with Jev, a few at a time, once.
const missing = everything.filter(c => !cached[c.id]);
if (missing.length && !process.env.TYPESAFE_API_KEY)
  throw new Error(`${missing.length} cases have no cached description and TYPESAFE_API_KEY is not set.`);
for (let i = 0; i < missing.length; i += 4) {
  await Promise.all(
    missing.slice(i, i + 4).map(async review => {
      const encoded = await encodeWithJev(review);
      cached[review.id] = { model: encoded.model, at: new Date().toISOString(), features: encoded.features };
    }),
  );
  await atomicJSON(odorsPath, cached);
  console.log(`described ${Math.min(i + 4, missing.length)} of ${missing.length}`);
}
const odorOf = (review: ReviewCase) => odorize(cached[review.id].features, changedText(review));

// Ground truth by execution, not by us.
const labels = new Map<string, { status: string; lesson: Lesson; reason: string }>();
for (const review of everything) {
  const { status } = await labelByExecution(review);
  labels.set(review.id, { status, ...lessonFor(status, Boolean(review.control)) });
}

// Seeded split: the held-out grown cases and all bundled examples are never taught.
let x = seed >>> 0 || 1;
const random = () => {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
};
const shuffled = [...grown].sort(() => random() - 0.5);
const holdoutCount = Math.round(grown.length * holdoutShare);
const holdout = shuffled.slice(0, holdoutCount);
const teachable = shuffled.slice(holdoutCount).filter(c => labels.get(c.id)!.lesson !== 'none');
// Equal numbers of punishments and rewards, so the fly's baseline is not pushed toward one valence by the corpus mix.
// Whatever the majority valence has left over is tested, not taught.
const balance = Math.min(
  teachable.filter(c => labels.get(c.id)!.lesson === 'punish').length,
  teachable.filter(c => labels.get(c.id)!.lesson === 'reward').length,
);
const punish = teachable.filter(c => labels.get(c.id)!.lesson === 'punish').slice(0, balance);
const reward = teachable.filter(c => labels.get(c.id)!.lesson === 'reward').slice(0, balance);
const training = [...punish, ...reward];
const spare = teachable.filter(c => !training.includes(c));
holdout.push(...spare);
// Interleave so neither valence runs ahead: the fly should not become wary of everything before it learns any comfort.
const order: ReviewCase[] = [];
for (let i = 0; i < Math.max(punish.length, reward.length); i++) {
  if (punish[i]) order.push(punish[i]);
  if (reward[i]) order.push(reward[i]);
}
console.log(
  `${grown.length} grown cases: teaching ${training.length} (${punish.length} punish, ${reward.length} reward), holding out ${holdout.length}; ${REVIEW_CASES.length} bundled examples never taught. rate ${rate}, passes ${passes}, seed ${seed}`,
);

const share = (b: ReviewBrain) => b.avoidHz / Math.max(1e-9, b.avoidHz + b.approachHz);
/** One retry: a bridge run is deterministic, so a second failure is real. */
const smell = async (...args: Parameters<typeof smellBrain>) => {
  try {
    return await smellBrain(...args);
  } catch (error) {
    console.log(`bridge run failed once (${(error as Error).message.slice(0, 80)}); retrying`);
    return smellBrain(...args);
  }
};
let lessons: LessonEntry[] = [];
const started = Date.now();
if (process.env.EVAL_ONLY) {
  lessons = (JSON.parse(await readFile(memoryPath, 'utf8')) as { lessons: LessonEntry[] }).lessons;
  console.log(`EVAL_ONLY: reusing ${lessons.length} lessons at ${memoryPath}`);
} else await rm(memoryPath, { force: true });
for (let pass = process.env.EVAL_ONLY ? passes + 1 : 1; pass <= passes; pass++) {
  for (const [i, review] of order.entries()) {
    const lesson = labels.get(review.id)!.lesson as Exclude<Lesson, 'none'>;
    const learned = await smell(odorOf(review), { seed, memoryPath, lesson, rate, shuffle });
    lessons.push({
      at: new Date().toISOString(),
      runDir: null,
      caseId: review.id,
      title: review.title,
      lesson,
      reason: labels.get(review.id)!.reason,
      activeKenyon: learned.activeKenyon,
      depressed: learned.depressed,
      rememberedSynapses: learned.rememberedSynapses,
      source: 'training',
      kenyonIds: learned.activeKenyonIds,
      smell: review.smell,
      teaching: summarizeTeaching(learned),
    });
    if ((i + 1) % 10 === 0 || i === order.length - 1)
      console.log(
        `pass ${pass}: ${i + 1}/${order.length} lessons, ${learned.rememberedSynapses.toLocaleString()} synapses carry memory (${((Date.now() - started) / 1000).toFixed(0)} s)`,
      );
  }
}

// The trained memory: factors written by the bridge, lessons written here, in the live format. Saved before testing so a
// failed evaluation never loses the teaching.
if (!process.env.EVAL_ONLY) {
  const taughtEdges = JSON.parse(await readFile(memoryPath, 'utf8')) as { edges: [number, number][] };
  await atomicJSON(memoryPath, { edges: taughtEdges.edges, lessons }, 0);
}

// Test on what it never smelled, and record the fit on what it did.
type Result = {
  caseId: string;
  title: string;
  set: 'holdout' | 'bundled' | 'training';
  smell?: string;
  control: boolean;
  status: string;
  expected: 'changes_requested' | 'no_objection' | null;
  naive: { verdict: string; share: number; feedHz: number };
  trained: { verdict: string; share: number; feedHz: number; behavior: 'reached' | 'still' };
  agrees: boolean | null;
  naiveAgrees: boolean | null;
};
const results: Result[] = [];
const evaluate = async (review: ReviewCase, set: Result['set']) => {
  const odor = odorOf(review);
  const naive = await smell(odor, { seed, memoryPath: null, shuffle });
  const trained = await smell(odor, { seed, memoryPath, shuffle });
  const truth = labels.get(review.id)!;
  const expected = truth.status === 'confirmed' ? 'changes_requested' : review.control ? 'no_objection' : null;
  const n = reviewVerdict(naive).verdict,
    tv = reviewVerdict(trained),
    t = tv.verdict;
  results.push({
    caseId: review.id,
    title: review.title,
    set,
    smell: review.smell,
    control: Boolean(review.control),
    status: truth.status,
    expected,
    naive: { verdict: n, share: share(naive), feedHz: naive.feedHz },
    trained: { verdict: t, share: share(trained), feedHz: trained.feedHz, behavior: tv.behavior },
    agrees: expected === null ? null : t === expected,
    naiveAgrees: expected === null ? null : n === expected,
  });
};
for (const review of holdout) await evaluate(review, 'holdout');
for (const review of REVIEW_CASES) await evaluate(review, 'bundled');
for (const review of training) await evaluate(review, 'training');

const summarize = (set: Result['set']) => {
  const judged = results.filter(r => r.set === set && r.agrees !== null);
  const regressions = judged.filter(r => !r.control),
    controls = judged.filter(r => r.control);
  return {
    judged: judged.length,
    agreeing: judged.filter(r => r.agrees).length,
    naiveAgreeing: judged.filter(r => r.naiveAgrees).length,
    regressionsCaught: `${regressions.filter(r => r.agrees).length}/${regressions.length}`,
    controlsApproved: `${controls.filter(r => r.agrees).length}/${controls.length}`,
    falseAlarms: controls.filter(r => r.trained.verdict === 'changes_requested').length,
    missedAsApproved: regressions.filter(r => r.trained.verdict === 'no_objection').length,
    abstained: judged.filter(r => r.trained.verdict === 'abstain').length,
    /** The body's own vote: how often the fly reached for a control, and for a regression. */
    reachedControls: `${controls.filter(r => r.trained.behavior === 'reached').length}/${controls.length}`,
    reachedRegressions: `${regressions.filter(r => r.trained.behavior === 'reached').length}/${regressions.length}`,
  };
};
const summary = { holdout: summarize('holdout'), bundled: summarize('bundled'), training: summarize('training') };

// What the nose reports differently for the two classes in the taught corpus. A receptor with a large gap that has nothing
// to do with behavior (comments, names) is a confound the fly will learn as readily as a real cue, so it is measured here.
const mean = (ids: ReviewCase[], key: string) =>
  ids.reduce((sum, c) => sum + (cached[c.id].features as Record<string, number>)[key], 0) / Math.max(1, ids.length);
const receptorGaps = Object.keys(cached[training[0].id].features)
  .map(key => {
    const controls = mean(
      training.filter(c => c.control),
      key,
    );
    const regressions = mean(
      training.filter(c => !c.control),
      key,
    );
    return { receptor: key, controls, regressions, gap: controls - regressions };
  })
  .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
console.log('\nreceptor gaps in the taught corpus (controls minus regressions):');
for (const g of receptorGaps.slice(0, 8))
  console.log(
    `  ${g.receptor.padEnd(22)} controls ${g.controls.toFixed(2)}  regressions ${g.regressions.toFixed(2)}  ${g.gap >= 0 ? '+' : ''}${g.gap.toFixed(2)}`,
  );
for (const set of ['holdout', 'bundled', 'training'] as const) {
  console.log(`\n${set}:`);
  for (const r of results.filter(r => r.set === set))
    console.log(
      `  ${r.caseId.padEnd(52)} ${(r.control ? 'control' : r.status).padEnd(15)} naive ${r.naive.share.toFixed(2)} ${r.naive.verdict.padEnd(17)} trained ${r.trained.share.toFixed(2)} MN9 ${r.trained.feedHz.toFixed(0).padStart(3)} ${r.trained.verdict.padEnd(17)} ${r.agrees === null ? '' : r.agrees ? 'agrees' : 'DISAGREES'}`,
    );
  const s = summary[set];
  console.log(
    `  => ${s.agreeing}/${s.judged} agree with execution (naive ${s.naiveAgreeing}/${s.judged}); regressions caught ${s.regressionsCaught}, controls approved ${s.controlsApproved}, false alarms ${s.falseAlarms}, regressions approved ${s.missedAsApproved}, abstained ${s.abstained}; reached for controls ${s.reachedControls}, for regressions ${s.reachedRegressions}`,
  );
}

const trainedEdges = JSON.parse(await readFile(memoryPath, 'utf8')) as { edges: [number, number][] };
await atomicJSON(join(ROOT, `.runs/training${tag}.json`), {
  at: new Date().toISOString(),
  note: "A fresh fly taught from executed outcomes on the grown corpus, then tested on held-out grown cases and on the bundled examples, none of which it smelled during training. Descriptions from cached Jev calls; labels from execution; lessons delivered as bitter or sugar with the fly's dopamine neurons gating which synapses change; no thresholds were tuned on the test sets.",
  shuffle,
  rate,
  passes,
  seed,
  holdoutShare,
  taught: { total: training.length, punish: punish.length, reward: reward.length },
  heldOut: holdout.length,
  rememberedSynapses: trainedEdges.edges.length,
  summary,
  receptorGaps,
  results,
});
console.log(
  `\nTrained memory: ${trainedEdges.edges.length.toLocaleString()} synapses, ${lessons.length} lessons at ${memoryPath}. Report: .runs/training${tag}.json`,
);
if (process.env.INSTALL) {
  const installed = await installMemory(memoryPath, MEMORY_PATH);
  console.log(`Installed as the live fly: ${installed.edges.toLocaleString()} synapses, ${installed.lessons} lessons.`);
}

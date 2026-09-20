import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { reviewVerdict, smellBrain } from './review-brain.ts';
import type { Descriptors, Lesson } from './review-brain.ts';
import { REVIEW_CASES, changedText } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';
import { encodeWithJev } from './review-jev.ts';
import { lessonFor } from './review-memory.ts';
import { odorize } from './review-odor.ts';
import { contractExpected, deterministicInputs } from './review-oracles.ts';
import { executeProbe } from './review-verify.ts';

/**
 * Leave-one-out: teach a fresh fly the other nine examples from executed outcomes, then let it smell the tenth.
 * Descriptions come from Jev once per example and are cached, so the experiment costs ten calls the first time and none
 * afterwards. Labels come from running the harness, not from us: a reproduced regression punishes; a designated control the
 * sweep cannot fault rewards; anything else teaches nothing.
 */
const passes = Number(process.env.PASSES ?? 2);
const odorsPath = join(ROOT, '.runs/odors.json');
await mkdir(join(ROOT, '.runs'), { recursive: true });

type Cached = Record<string, { model: string; at: string; features: Descriptors }>;
let cached: Cached = {};
try {
  cached = JSON.parse(await readFile(odorsPath, 'utf8')) as Cached;
} catch {
  /* first run */
}
for (const review of REVIEW_CASES) {
  if (cached[review.id]) continue;
  if (!process.env.TYPESAFE_API_KEY)
    throw new Error(`No cached description for ${review.id} and no TYPESAFE_API_KEY to fetch one.`);
  const encoded = await encodeWithJev(review);
  cached[review.id] = { model: encoded.model, at: new Date().toISOString(), features: encoded.features };
  await atomicJSON(odorsPath, cached);
  console.log(`described ${review.id} with ${encoded.model}`);
}

// Ground truth by execution, not by us.
const labels = new Map<string, { status: string; lesson: Lesson; reason: string }>();
for (const review of REVIEW_CASES) {
  const args = deterministicInputs(review)[0];
  const receipt = await executeProbe(
    review,
    { args, expected: contractExpected(review, args), rationale: 'leave-one-out label' },
    'harness',
  );
  const { lesson, reason } = lessonFor(receipt.status, Boolean(review.control));
  labels.set(review.id, { status: receipt.status, lesson, reason });
}
const odorOf = (review: ReviewCase) => odorize(cached[review.id].features, changedText(review));

const folds = [];
for (const held of REVIEW_CASES) {
  const memoryPath = join(ROOT, `.runs/loo-${held.id}.json`);
  await rm(memoryPath, { force: true });
  const naive = reviewVerdict(await smellBrain(odorOf(held), { memoryPath }));
  const trained = [];
  for (let pass = 1; pass <= passes; pass++) {
    for (const other of REVIEW_CASES) {
      if (other.id === held.id) continue;
      const lesson = labels.get(other.id)!.lesson;
      if (lesson !== 'none') await smellBrain(odorOf(other), { memoryPath, lesson });
    }
    const after = await smellBrain(odorOf(held), { memoryPath });
    trained.push({
      pass,
      verdict: reviewVerdict(after).verdict,
      share: after.avoidHz / Math.max(1e-9, after.avoidHz + after.approachHz),
      rememberedSynapses: after.rememberedSynapses,
    });
  }
  await rm(memoryPath, { force: true });
  const truth = labels.get(held.id)!;
  const expected = truth.status === 'confirmed' ? 'changes_requested' : held.control ? 'no_objection' : null;
  const final = trained.at(-1)!;
  folds.push({
    caseId: held.id,
    title: held.title,
    control: Boolean(held.control),
    status: truth.status,
    expected,
    naive: naive.verdict,
    naiveShare: naive.score,
    trained,
    agrees: expected === null ? null : final.verdict === expected,
  });
  console.log(
    `${held.id.padEnd(13)} truth ${truth.status.padEnd(15)} naive ${naive.verdict.padEnd(17)} ${trained.map(t => `pass ${t.pass}: ${t.verdict} (${t.share.toFixed(2)})`).join('  ')}  ${expected === null ? '' : final.verdict === expected ? 'agrees' : 'DISAGREES'}`,
  );
}
const judged = folds.filter(f => f.agrees !== null);
const agreeing = judged.filter(f => f.agrees).length;
const naiveAgreeing = judged.filter(f => f.naive === f.expected).length;
await atomicJSON(join(ROOT, '.runs/leave-one-out.json'), {
  at: new Date().toISOString(),
  note: 'Held-out generalization on the bundled examples. Descriptions from cached Jev calls; labels from executed tests; the fly never smelled the held-out change before voting on it.',
  passes,
  folds,
  agreeing,
  judged: judged.length,
  naiveAgreeing,
});
console.log(
  `Held out: ${agreeing} of ${judged.length} trained votes agree with the executed tests (naive fly: ${naiveAgreeing} of ${judged.length}). Evidence: .runs/leave-one-out.json`,
);

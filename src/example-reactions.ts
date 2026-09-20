import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { REVIEW_CASES } from './review-cases.ts';
import { encodeWithJev } from './review-jev.ts';
import { appendLedger } from './review-ledger.ts';
import { reviewVerdict, smellBrain } from './review-brain.ts';
import { odorize } from './review-odor.ts';
import { changedText } from './review-cases.ts';

if (!process.env.TYPESAFE_API_KEY)
  throw new Error('TYPESAFE_API_KEY is required: this measurement uses live Jev, not fixture probabilities.');
await mkdir(join(ROOT, '.runs'), { recursive: true });
const results = [];
const path = join(ROOT, '.runs/example-reactions.json');
for (const review of REVIEW_CASES) {
  for (let trial = 1; trial <= 2; trial++) {
    const encoded = await encodeWithJev(review);
    const odor = odorize(encoded.features, changedText(review));
    const brain = await smellBrain(odor, { seed: 7 });
    const verdict = reviewVerdict(brain);
    results.push({
      caseId: review.id,
      title: review.title,
      trial,
      model: encoded.model,
      features: encoded.features,
      seed: brain.seed,
      gain: brain.gain,
      rates: brain.rates,
      odor,
      outputs: {
        feedHz: brain.feedHz,
        groomHz: brain.groomHz,
        escapeHz: brain.escapeHz,
        avoidHz: brain.avoidHz,
        approachHz: brain.approachHz,
        activeKenyon: brain.activeKenyon,
        rememberedSynapses: brain.rememberedSynapses,
      },
      verdict,
    });
    await appendLedger({
      type: 'vote',
      at: new Date().toISOString(),
      runDir: null,
      caseId: review.id,
      custom: false,
      feedHz: brain.feedHz,
      groomHz: brain.groomHz,
      escapeHz: brain.escapeHz,
      verdict: verdict.verdict,
    });
    console.log(
      `${review.id} #${trial}: ${verdict.verdict} (${verdict.score.toFixed(3)}) | ${JSON.stringify(encoded.features)}`,
    );
    await atomicJSON(path, {
      at: new Date().toISOString(),
      note: 'Two live Jev calls per case; fixed encoder, seed, gain and readout. Observed reactions, not promises or an accuracy benchmark.',
      results,
    });
  }
}
console.log(`Observed verdicts: ${[...new Set(results.map(r => r.verdict.verdict))].join(', ')}. Evidence: ${path}`);

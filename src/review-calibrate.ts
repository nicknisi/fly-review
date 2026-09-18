import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { FEATURE_KEYS, reviewBrain, reviewVerdict } from './review-brain.ts';
import type { Features, ReviewBrain } from './review-brain.ts';

const vectors = [[0,0,0,0],[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1],[.5,.5,.5,.5],[.9,.8,.1,.9]];
const results = [];
for (const vector of vectors) {
  const features = Object.fromEntries(FEATURE_KEYS.map((key,i)=>[key,vector[i]])) as Features;
  const reading = await reviewBrain(features);
  const verdict = reviewVerdict(reading);
  results.push({ features, reading, verdict });
  console.log(`${vector.join('/')} -> A=${reading.feedHz} B=${reading.groomHz} C=${reading.escapeHz} Hz -> ${verdict.verdict}`);
}
const target = results[5];
const repeat = await reviewBrain(target.features);
const strip = ({ wallMs: _wall, ...value }: ReviewBrain) => value;
const identical = JSON.stringify(strip(repeat)) === JSON.stringify(strip(target.reading));
const disconnected = await reviewBrain(target.features, 7, 0);
const ablated = disconnected.feedHz + disconnected.groomHz + disconnected.escapeHz === 0;
const distinctReadouts = new Set(results.map(r=>[r.reading.feedHz,r.reading.groomHz,r.reading.escapeHz].join('/'))).size;
const distinctVerdicts = new Set(results.map(r=>r.verdict.verdict)).size;
const passed = identical && ablated && distinctReadouts > 2 && distinctVerdicts === 3;
await mkdir(join(ROOT, '.runs'), { recursive: true });
await atomicJSON(join(ROOT, '.runs/review-assays.json'), { at:new Date().toISOString(), note:'Feasibility and determinism only. Not code-review accuracy or biological validation.', results, repeat, disconnected, identical, ablated, distinctReadouts, distinctVerdicts, passed });
console.log(`Repeated data identical: ${identical}. Disconnected output zero: ${ablated}. Distinct readouts: ${distinctReadouts}; verdicts: ${distinctVerdicts}.`);
console.log('Evidence: .runs/review-assays.json');
if (!passed) process.exitCode = 1;

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { smellBrain } from './review-brain.ts';
import type { Descriptors } from './review-brain.ts';
import { REVIEW_CASES, changedText } from './review-cases.ts';
import { odorize } from './review-odor.ts';
import { VERDICT_RULE } from './review-verdict.ts';

/**
 * How fragile is a vote? Jev's description of one change wobbles by a few hundredths between calls, so the fly's answer
 * on the page can differ from the answer on the cached description. This perturbs every bundled example's cached
 * descriptors by a small uniform jitter a few times and reports which cases change verdict, for one or more memories.
 *
 *   npm run wobble                          MEMORIES=.runs/trained-memory.json,... JITTER=0.03 REPEATS=4 SEED=11
 */
const memories = (process.env.MEMORIES ?? '.runs/trained-memory.json').split(',').map(m => m.trim());
const jitter = Number(process.env.JITTER ?? 0.03);
const repeats = Number(process.env.REPEATS ?? 4);
let state = Number(process.env.SEED ?? 11) >>> 0 || 1;
const random = () => {
  state = (state * 1103515245 + 12345) & 0x7fffffff;
  return state / 0x7fffffff;
};
const cached = JSON.parse(await readFile(join(ROOT, '.runs/odors.json'), 'utf8')) as Record<
  string,
  { features: Descriptors }
>;
const code = (b: { avoidHz: number; approachHz: number; feedHz: number }) => {
  const total = b.avoidHz + b.approachHz;
  if (b.feedHz >= VERDICT_RULE.reachHz) return 'R'; // reached
  if (total < VERDICT_RULE.minimumHz) return 'q'; // quiet mushroom body
  const share = b.avoidHz / total;
  return share >= VERDICT_RULE.objection ? 'C' : share <= VERDICT_RULE.approval ? 'n' : 'a';
};
const report: Record<string, unknown> = {};
for (const memory of memories) {
  const memoryPath = join(ROOT, memory);
  const rows: { caseId: string; control: boolean; verdicts: string; changes: boolean }[] = [];
  for (const c of REVIEW_CASES) {
    if (!cached[c.id]) throw new Error(`${c.id} has no cached description; run npm run train first`);
    const base = cached[c.id].features as Record<string, number>;
    let verdicts = '';
    for (let k = 0; k < repeats; k++) {
      const features = Object.fromEntries(
        Object.entries(base).map(([key, v]) => [
          key,
          k === 0 ? v : Math.min(1, Math.max(0, v + (random() - 0.5) * 2 * jitter)),
        ]),
      ) as unknown as Descriptors;
      verdicts += code(await smellBrain(odorize(features, changedText(c)), { seed: 7, memoryPath }));
    }
    rows.push({ caseId: c.id, control: Boolean(c.control), verdicts, changes: new Set(verdicts).size > 1 });
  }
  const changed = rows.filter(r => r.changes).length;
  console.log(
    `== ${memory}: ${changed}/${rows.length} bundled cases change verdict under ±${jitter} description wobble (R reached, n lean, a abstain, C changes requested, q quiet)`,
  );
  for (const r of rows) console.log(`   ${r.caseId.padEnd(16)} ${r.verdicts}${r.changes ? '  <- changes' : ''}`);
  report[memory] = { changed, rows };
}
await atomicJSON(join(ROOT, '.runs/wobble.json'), { at: new Date().toISOString(), jitter, repeats, report });
console.log('Evidence: .runs/wobble.json');

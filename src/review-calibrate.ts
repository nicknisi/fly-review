import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { VERDICT_RULE, reviewVerdict, smellBrain } from './review-brain.ts';
import type { ReviewBrain } from './review-brain.ts';
import { odorKey } from './review-odor.ts';
import type { Odor } from './review-odor.ts';

/**
 * Calibration presents odors directly to a fly with a scratch memory and never sees a code example. It establishes:
 * the naive fly's avoid/approach balance and stillness, that different odors drive different Kenyon cells, that bitter
 * (through PPL1) and sugar (through PAM) change the answer for the taught odor and not for an unrelated one, that a
 * rewarded smell makes the fly reach (MN9) where a naive one never does, and that the run is reproducible and the
 * wiring matters. VERDICT_RULE's lines are justified by these numbers; change them here first.
 */
const memoryPath = join(ROOT, '.runs/calibration-memory.json');
const odor = (...glomeruli: string[]): Odor => Object.fromEntries(glomeruli.map(g => [odorKey(g as never), 150]));
const A = odor('ORN_DM1', 'ORN_VA2'),
  B = odor('ORN_DL3', 'ORN_VC1'),
  AB = odor('ORN_DM1', 'ORN_DL3');
const share = (b: ReviewBrain) => b.avoidHz / Math.max(1e-9, b.avoidHz + b.approachHz);
const jaccard = (x: number[], y: number[]) => {
  const sx = new Set(x),
    sy = new Set(y);
  let inter = 0;
  for (const v of sx) if (sy.has(v)) inter++;
  return inter / (sx.size + sy.size - inter);
};

await mkdir(join(ROOT, '.runs'), { recursive: true });
await rm(memoryPath, { force: true });
const results: Record<string, unknown> = {};
const log = (name: string, b: ReviewBrain) => {
  const v = reviewVerdict(b);
  results[name] = {
    activeKenyon: b.activeKenyon,
    avoidHz: b.avoidHz,
    approachHz: b.approachHz,
    share: share(b),
    feedHz: b.feedHz,
    ppl1Hz: b.ppl1Hz,
    pamHz: b.pamHz,
    behavior: v.behavior,
    verdict: v.verdict,
    rememberedSynapses: b.rememberedSynapses,
  };
  console.log(
    `${name.padEnd(46)} KC ${String(b.activeKenyon).padStart(4)}  avoid ${b.avoidHz.toFixed(0).padStart(4)}  approach ${b.approachHz.toFixed(0).padStart(4)}  share ${share(b).toFixed(2)}  MN9 ${b.feedHz.toFixed(0).padStart(3)} Hz ${v.behavior.padEnd(7)} -> ${v.verdict}`,
  );
  return b;
};
const lessons: Record<string, unknown> = {};
const teach = async (name: string, o: Odor, lesson: 'punish' | 'reward') => {
  const b = await smellBrain(o, { memoryPath, lesson });
  const t = b.teaching!;
  const groups = { avoid: 0, approach: 0, novelty: 0 };
  for (const c of Object.values(t.compartments)) groups[c.group] += c.depressed;
  lessons[name] = {
    pathway: t.pathway,
    ppl1Hz: b.ppl1Hz,
    pamHz: b.pamHz,
    feedHz: b.feedHz,
    depressed: b.depressed,
    byGroup: groups,
    compartments: t.compartments,
  };
  console.log(
    `${name.padEnd(46)} ${t.pathway.padEnd(12)} PPL1 ${b.ppl1Hz!.toFixed(0).padStart(3)} Hz  PAM ${b.pamHz!.toFixed(0).padStart(3)} Hz  MN9 ${b.feedHz.toFixed(0).padStart(3)} Hz  depressed ${b.depressed} (avoid ${groups.avoid}, approach ${groups.approach}, novelty ${groups.novelty})`,
  );
  return b;
};

const quiet = log('nothing offered', await smellBrain({}, { memoryPath }));
const naiveA = log('naive fly, odor A (DM1+VA2)', await smellBrain(A, { memoryPath }));
const naiveB = log('naive fly, odor B (DL3+VC1)', await smellBrain(B, { memoryPath }));
const naiveAB = log('naive fly, odor A/B (DM1+DL3)', await smellBrain(AB, { memoryPath }));
const overlapAB = jaccard(naiveA.activeKenyonIds, naiveB.activeKenyonIds),
  overlapAAB = jaccard(naiveA.activeKenyonIds, naiveAB.activeKenyonIds);
console.log(
  `Kenyon-cell overlap: A vs B ${overlapAB.toFixed(2)}, A vs A/B ${overlapAAB.toFixed(2)} (the code is odor-specific and similarity is graded).`,
);
const bitter1 = await teach('bitter with A (1st)', A, 'punish');
await teach('bitter with A (2nd)', A, 'punish');
const punishedA = log('after punishing A twice: odor A', await smellBrain(A, { memoryPath }));
const punishedB = log('after punishing A twice: odor B', await smellBrain(B, { memoryPath }));
const punishedAB = log('after punishing A twice: odor A/B', await smellBrain(AB, { memoryPath }));
const sugar1 = await teach('sugar with B (1st)', B, 'reward');
await teach('sugar with B (2nd)', B, 'reward');
const rewardedB = log('after rewarding B twice: odor B', await smellBrain(B, { memoryPath }));
const stillA = log('after rewarding B twice: odor A', await smellBrain(A, { memoryPath }));
const repeat = await smellBrain(A, { memoryPath });
const strip = ({ wallMs: _w, ...rest }: ReviewBrain) => rest;
const identical = JSON.stringify(strip(repeat)) === JSON.stringify(strip(stillA));
const disconnected = await smellBrain(A, { memoryPath, gain: 0 });
const ablated = disconnected.avoidHz + disconnected.approachHz + disconnected.feedHz === 0;

/** Dopamine delivered per readout group: synapses touched, weighted by the dopamine their compartment saw. */
const groupsOf = (b: ReviewBrain) => {
  const g = { avoid: 0, approach: 0, novelty: 0 };
  for (const c of Object.values(b.teaching!.compartments)) g[c.group] += c.depressed * c.dopamine;
  return g;
};
const checks = {
  quietIsSilent: quiet.avoidHz + quiet.approachHz === 0,
  naiveIsUndecided: [naiveA, naiveB, naiveAB].every(b => reviewVerdict(b).verdict === 'abstain'),
  naiveIsStill: [naiveA, naiveB, naiveAB].every(b => b.feedHz === 0 && reviewVerdict(b).behavior === 'still'),
  // The teaching neurons fire only while a taste is delivered, and the connectome routes bitter's dopamine mostly onto
  // approach MBONs and sugar's mostly onto avoidance MBONs. That routing is the fly's; the readout labels only count it.
  dopamineIsQuietInReview: [naiveA, naiveB, naiveAB].every(b => b.ppl1Hz! < 10 && b.pamHz! < 1),
  bitterFiresPpl1NotPam: bitter1.ppl1Hz! > 100 && bitter1.pamHz! < 5,
  sugarFiresPamNotPpl1: sugar1.pamHz! > 100 && sugar1.ppl1Hz! < 40,
  bitterDepressesApproachCompartments: groupsOf(bitter1).approach > 2 * groupsOf(bitter1).avoid,
  sugarDepressesAvoidCompartments: groupsOf(sugar1).avoid > 2 * groupsOf(sugar1).approach,
  rewardedSmellIsReachedFor:
    rewardedB.feedHz >= VERDICT_RULE.reachHz && reviewVerdict(rewardedB).behavior === 'reached',
  punishedSmellIsNotReachedFor: punishedA.feedHz < VERDICT_RULE.reachHz,
  odorCodeIsSpecific: overlapAB < 0.15 && overlapAAB > overlapAB + 0.15,
  punishmentTeachesA:
    reviewVerdict(punishedA).verdict === 'changes_requested' && share(punishedA) > share(naiveA) + 0.15,
  punishmentSparesB: Math.abs(share(punishedB) - share(naiveB)) < 0.06,
  punishmentGeneralizesToSimilar: share(punishedAB) > share(naiveAB) + 0.05 && share(punishedAB) < share(punishedA),
  rewardTeachesB: reviewVerdict(rewardedB).verdict === 'no_objection' && share(rewardedB) < share(naiveB) - 0.15,
  rewardSparesA: Math.abs(share(stillA) - share(punishedA)) < 0.06,
  identical,
  ablated,
};
const passed = Object.values(checks).every(Boolean);
await atomicJSON(join(ROOT, '.runs/calibration.json'), {
  at: new Date().toISOString(),
  note: 'Direct odor presentation to a scratch memory; no code example is involved. Establishes the verdict lines and that learning is odor-specific, not review accuracy or biological fidelity.',
  rule: VERDICT_RULE,
  results,
  lessons,
  overlapAB,
  overlapAAB,
  checks,
  passed,
});
await rm(memoryPath, { force: true });
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`Evidence: .runs/calibration.json${passed ? '' : ' (FAILED)'}`);
if (!passed) process.exitCode = 1;

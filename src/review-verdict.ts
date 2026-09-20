import type { FlyVerdict, ReviewBrain } from './review-brain.ts';

/**
 * Browser-safe voting rule. Calibrated on direct odor presentations (npm run calibrate), never on the examples.
 *
 * The body first: if the proboscis motor neurons (MN9) fire to the smell alone, the fly reached for it, and that is its
 * approval. A naive fly never reaches for an odor; one that has been rewarded in its presence does. Objection has no
 * motor expression in this model (an odor the fly was punished with changes what its avoidance and approach MBONs say,
 * but nothing downstream of them reaches the legs or the wings), so an objection is read from those MBON populations:
 * avoidance share = avoid / (avoid + approach). Between the lines, and when the mushroom body barely answers, it abstains.
 */
export const VERDICT_RULE = { objection: 0.68, approval: 0.45, minimumHz: 20, reachHz: 8 } as const;
export function reviewVerdict(brain: Pick<ReviewBrain, 'avoidHz' | 'approachHz' | 'feedHz'>): FlyVerdict {
  if (![brain.avoidHz, brain.approachHz, brain.feedHz].every(n => Number.isFinite(n) && n >= 0))
    throw new Error('Invalid mushroom body readout');
  const total = brain.avoidHz + brain.approachHz;
  const score = total > 0 ? brain.avoidHz / total : 0.5;
  const behavior = brain.feedHz >= VERDICT_RULE.reachHz ? 'reached' : 'still';
  const rates = `avoid ${brain.avoidHz.toFixed(0)} Hz, approach ${brain.approachHz.toFixed(0)} Hz`;
  if (behavior === 'reached')
    return {
      verdict: 'no_objection',
      score,
      behavior,
      explanation: `The fly reached for it: its proboscis motor neurons fired (MN9 ${brain.feedHz.toFixed(0)} Hz) to the smell alone, which a naive fly never does. Its memory associates this smell, or one like it, with sugar (${rates}, share ${score.toFixed(2)}). That does not establish that the code is correct.`,
    };
  if (total < VERDICT_RULE.minimumHz)
    return {
      verdict: 'abstain',
      score,
      behavior,
      explanation: `The body stayed still and the mushroom body barely answered (${rates}). Nothing to vote with.`,
    };
  if (score >= VERDICT_RULE.objection)
    return {
      verdict: 'changes_requested',
      score,
      behavior,
      explanation: `The body stayed still and its avoidance MBONs outweighed approach (${rates}, share ${score.toFixed(2)}). This smell, or one like it, was paired with bitter in the fly's memory. A neural classification, not a bug explanation.`,
    };
  if (score <= VERDICT_RULE.approval)
    return {
      verdict: 'no_objection',
      score,
      behavior,
      explanation: `Its approach MBONs outweighed avoidance (${rates}, share ${score.toFixed(2)}) though it did not reach for it (MN9 ${brain.feedHz.toFixed(0)} Hz). A lean, not an appetite. That does not establish that the code is correct.`,
    };
  return {
    verdict: 'abstain',
    score,
    behavior,
    explanation: `The body stayed still and neither MBON class won (${rates}, share ${score.toFixed(2)}). The fly has no learned opinion about this smell.`,
  };
}

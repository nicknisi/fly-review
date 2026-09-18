import type { Features, FlyVerdict, ReviewBrain } from './review-brain.ts';
import type { ReviewCase } from './review-cases.ts';
import type { VerificationReceipt } from './review-verify.ts';

export type ReviewPhase = 'idle' | 'encoding' | 'simulating' | 'ready' | 'ablating' | 'investigating' | 'verified' | 'error';
export type ReviewState = {
  phase: ReviewPhase; busy: boolean; review: ReviewCase;
  headline: string; explanation: string;
  source: 'jev' | 'manual' | null; features: Features | null; encoderModel: string | null;
  brain: ReviewBrain | null; verdict: FlyVerdict | null;
  ablation: ReviewBrain | null; repeat: { identical: boolean; reading: ReviewBrain } | null;
  verification: VerificationReceipt | null; vote: 'yes' | 'no' | 'unsure' | null;
  hasJev: boolean; hasInvestigator: boolean; runDir: string | null;
  log: { at: string; text: string }[];
};

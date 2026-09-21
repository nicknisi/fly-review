import type { ChannelDiagnosis, Features, FlyVerdict, HunkReading, ReviewBrain } from './review-brain.ts';
import type { ReviewUnit } from './review-hunks.ts';
import type { LessonEntry, Memory, MemorySnapshot } from './review-memory.ts';

export type AttendedUnit = Omit<ReviewUnit, 'patch' | 'changed'> & {
  reading: HunkReading;
  /** Avoidance share of this hunk's valence readout. */
  share: number;
  /** This hunk's own vote, from the same rule a single change gets. */
  vote: FlyVerdict['verdict'];
  reached: boolean;
  features: Features;
};
/** Every hunk's vote counted. When no hunk stands out, this is the fly's vote on the pull request. */
export type HunkTally = {
  changes_requested: number;
  no_objection: number;
  abstain: number;
  reached: number;
  total: number;
};
export type Attention = {
  granularity: 'hunk' | 'file';
  skipped: number;
  /** Exposure-driven depression per presentation and the number of reading passes before the frozen readout. */
  familiarity: number;
  readings: number;
  looked: number;
  /** Whether the looked-at hunk stood out from the rest (standsOut); when it did not, the vote is the tally. */
  stands: boolean;
  tally: HunkTally;
  units: AttendedUnit[];
};

export type NearestLesson = {
  caseId: string;
  title: string;
  lesson: LessonEntry['lesson'];
  source: LessonEntry['source'];
  smell?: string;
  /** Jaccard overlap between the active Kenyon-cell sets of this trial and of the lesson. */
  overlap: number;
  shared: number;
};
import type { Odor } from './review-odor.ts';
import type { ReviewCase } from './review-cases.ts';
import type { Ledger } from './review-ledger.ts';
import type { PokeStimuli } from './review-pokes.ts';
import type { VerificationReceipt } from './review-verify.ts';

export type ReviewPhase =
  'idle' | 'encoding' | 'simulating' | 'ready' | 'ablating' | 'investigating' | 'verified' | 'error';
export type VoteRecord = {
  runId: string;
  seed: number;
  memoryHash: string;
  descriptorHash: string;
  verdict: FlyVerdict;
  label: string;
};
export type PokeRecording = {
  at: string;
  stimuli: PokeStimuli;
  brain: ReviewBrain;
  channels: ChannelDiagnosis;
  receiptId: string;
  memoryInput: MemorySnapshot;
};
export type ReviewState = {
  phase: ReviewPhase;
  busy: boolean;
  review: ReviewCase;
  headline: string;
  explanation: string;
  source: 'jev' | 'manual' | null;
  features: Features | null;
  encoderModel: string | null;
  brain: ReviewBrain | null;
  verdict: FlyVerdict | null;
  /** Which readout channels fired in the recorded trial, and what that means for the vote. */
  channels: ChannelDiagnosis | null;
  /** The odor this review presented: glomerulus rates from Jev's descriptors and the changed tokens. */
  odor: Odor | null;
  /** What this run's verification taught the fly, if anything. */
  lesson: LessonEntry | null;
  /** The teaching trial itself, recorded like a review: the taste on, the dopamine neurons firing, synapses changing. */
  teaching: ReviewBrain | null;
  /** The fly's memory: how many synapses differ from naive and what taught them. Kenyon-cell ids stay on the server. */
  memory: Memory;
  /** Lessons whose odor code overlaps most with this trial's active Kenyon cells: a similarity, not a cause. */
  nearest: NearestLesson[] | null;
  /** A pull request read hunk by hunk: every puff's readout, and the one the fly looked at. Null for single changes. */
  attention: Attention | null;
  memoryInput: MemorySnapshot | null;
  /** Prior votes in this frozen-description recall chain; every entry links to its saved run. */
  history: VoteRecord[];
  recordingHistorical: boolean;
  memoryComparison: { current: ReviewBrain; naive: ReviewBrain; memoryInput: MemorySnapshot } | null;
  odorCodeVersion: string;
  ablation: ReviewBrain | null;
  repeat: { identical: boolean; reading: ReviewBrain } | null;
  verification: VerificationReceipt | null;
  vote: 'yes' | 'no' | 'unsure' | null;
  hasJev: boolean;
  hasInvestigator: boolean;
  /** A GitHub token (env or gh CLI) is available, so pull requests can be fetched privately and the fly's review can be posted. */
  hasGitHub: boolean;
  /** Where the fly's review landed on GitHub, if it was posted. */
  posted: { url: string; at: string } | null;
  /** The latest direct stimulation of a sensory population, independent of any review. */
  poke: PokeRecording | null;
  pokePair: { sugar: PokeRecording; mixed: PokeRecording } | null;
  poking: boolean;
  runDir: string | null;
  log: { at: string; text: string }[];
  /** The fly's record on this machine, folded from .runs/ledger.jsonl. */
  ledger: Ledger;
};

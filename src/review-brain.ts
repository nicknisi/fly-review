import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, ROOT, RUNS_ROOT } from './io.ts';
import { reviewVerdict, VERDICT_RULE } from './review-verdict.ts';
export { reviewVerdict, VERDICT_RULE } from './review-verdict.ts';
import { parsePokeStimuli } from './review-pokes.ts';
import type { PokePreset, PokeStimuli } from './review-pokes.ts';
import { RECEPTOR_KEYS, odorize, parseDescriptors } from './review-odor.ts';
import type { Descriptors, Odor, ReceptorKey } from './review-odor.ts';
export { RECEPTOR_KEYS, parseDescriptors } from './review-odor.ts';
export type { Descriptors, ReceptorKey } from './review-odor.ts';
export type FeatureKey = ReceptorKey;
/** Kept as the name the rest of the code uses for Jev's output. */
export type Features = Descriptors;
export const FEATURE_KEYS = RECEPTOR_KEYS;
export const parseFeatures = parseDescriptors;
export const MEMORY_PATH = join(RUNS_ROOT, 'memory.json');
export type Lesson = 'none' | 'punish' | 'reward';
export type Point3 = [number, number, number];
export type ActivePoint3 = [number, number, number, number];
/** [pre body ID, post body ID, synapse count, pre x/y/z, post x/y/z]. */
export type Link3 = [number, number, number, number, number, number, number, number, number];
/** Soma positions of the three readout populations (A feeding MN9, B grooming DNg62, C escape DNp01), in per-frame count order. */
export type Readouts3 = [Point3[], Point3[], Point3[]];
export type BrainAnatomy = {
  neurons: number;
  connections: number;
  geometry3d: Point3[];
  links3d: Link3[];
  readouts3d?: Readouts3;
  pokes?: Record<PokePreset, number>;
  mushroomBody?: MushroomBody;
  mushroom3d?: Mushroom3d;
};
/**
 * Soma positions of the mushroom body: a sample of Kenyon cells, every MBON by class, and the dopamine neurons (PPL1,
 * PAM), all in per-frame count order.
 */
export type Mushroom3d = { kenyon: Point3[]; avoid: Point3[]; approach: Point3[]; ppl1?: Point3[]; pam?: Point3[] };
/** The teaching neurons and the fixed physiology of a lesson, as the bridge reports them. */
export type Dopamine = {
  /** PPL1 cells (punishment's dopamine neurons; they innervate the approach compartments). */
  ppl1: number;
  /** PAM cells (reward's dopamine neurons; they innervate the avoidance compartments). */
  pam: number;
  /** PPL1-α'3 cells: exposure-driven dopamine in the novelty compartment. */
  alphaPrime3: number;
  /** MBONs with at least one dopamine neuron wired onto them. */
  compartments: number;
  tasteHz: number;
  danHz: number;
  exposureHz: number;
  eligibleMs: number;
  tickMs: number;
};
export type MushroomBody = {
  kenyonCells: number;
  avoidMbons: number;
  approachMbons: number;
  /** The α'3 compartment's MBONs (MBON17 in hemibrain numbering, MBON-α'3m): novelty, not valence. */
  noveltyMbons: number;
  plasticSynapses: number;
  /** Synapses whose strength the fly's memory has changed from naive. */
  rememberedSynapses: number;
  kcMbonScale: number;
  dopamine?: Dopamine;
};
/** What one lesson did inside the run: which taste, how much the dopamine neurons fired, what changed per compartment. */
export type Teaching = {
  /** bitter+ppl1 (punishment), sugar+pam (reward), or alphaPrime3 (exposure while reading a sequence). */
  pathway: 'bitter+ppl1' | 'sugar+pam' | 'alphaPrime3';
  ppl1Spikes: number;
  pamSpikes: number;
  alphaPrime3Spikes: number;
  /** Per MBON type: its readout group, synapses depressed, their mean factor after, and the mean dopamine it saw per tick. */
  compartments: Record<
    string,
    { group: 'avoid' | 'approach' | 'novelty'; depressed: number; meanFactor: number; dopamine: number }
  >;
};
export type ReviewFrame = {
  timeMs: number;
  feedHz: number;
  groomHz: number;
  escapeHz: number;
  /** Mushroom body output in this bin: avoidance-driving and approach-driving MBON population rates, and active Kenyon cells. */
  avoidHz?: number;
  approachHz?: number;
  activeKenyon?: number;
  spikes: number;
  inputSpikes: number[];
  activity: [number, number, number][];
  activity3d?: ActivePoint3[];
  /** Spikes per readout neuron in this bin, aligned to readouts3d. Absent on legacy recordings. */
  readoutCounts?: [number[], number[], number[]];
  /** Kenyon cells that fired in this bin, at their real positions: the odor code, visible. */
  kenyonActive3d?: Point3[];
  /** Spikes per MBON in this bin: [avoid..., approach...], aligned to mushroom3d. */
  mbonCounts?: [number[], number[]];
  /** Dopamine neuron rates in this bin. */
  ppl1Hz?: number;
  pamHz?: number;
  /** Spikes per dopamine neuron in this bin: [ppl1..., pam...], aligned to mushroom3d. */
  danCounts?: [number[], number[]];
};
export type ReviewBrain = {
  neurons: number;
  connections: number;
  projection: [number, number][];
  geometry3d?: Point3[];
  links3d?: Link3[];
  readoutSizes?: [number, number, number];
  readouts3d?: Readouts3;
  /** Sizes of the sensory populations that can be poked directly, by preset name. */
  pokes?: Record<PokePreset, number>;
  /** The populations and rates actually stimulated: an odor (odor:ORN_x keys) for a review, named populations for a poke. */
  stimuli?: Odor | PokeStimuli;
  mushroomBody?: MushroomBody;
  mushroom3d?: Mushroom3d;
  feedHz: number;
  groomHz: number;
  escapeHz: number;
  /** Mushroom body output over the recorded 250 ms. */
  avoidHz: number;
  approachHz: number;
  /** The α'3 novelty MBONs' rate: loud for an unfamiliar smell, quiet for one the fly has just been exposed to. */
  noveltyHz: number;
  /** Dopamine neuron population rates over the whole trial: quiet in an ordinary review, firing during a lesson. */
  ppl1Hz?: number;
  pamHz?: number;
  activeKenyon: number;
  activeKenyonIds: number[];
  /** What this run taught the fly, if anything, and how many synapses it changed. */
  lesson: Lesson;
  depressed: number;
  rememberedSynapses: number;
  /** The lesson's receipt from inside the run; null for an ordinary review. */
  teaching?: Teaching | null;
  /** A wiring ablation applied to the connectome before this run (npm run train SHUFFLE=...), or null. */
  shuffle?: string | null;
  spikes: number;
  wallMs: number;
  simulatedMs: number;
  frames: ReviewFrame[];
  activity: [number, number, number][];
  seed: number;
  gain: number;
  /** Per review channel (in REVIEW_CHANNELS order) for a review; per stimulated population for a poke. */
  rates: number[];
  /** Present when several odors were read in turn: the reading is the hunk the fly looked at, and this is the rest. */
  sequence?: SequenceReading;
};
/** One hunk's readout in a sequence, taken with familiarity synapses frozen after the reading pass. */
export type HunkReading = {
  index: number;
  avoidHz: number;
  approachHz: number;
  noveltyHz: number;
  /** What the same odor evoked with fresh α'3 synapses: its first-exposure response. */
  naiveNoveltyHz: number;
  /** 1 - noveltyHz / naiveNoveltyHz, clipped: 0 is brand new, 1 is fully familiar. */
  familiarity: number;
  /** Proboscis motor neuron rate on the frozen readout pass: did the fly reach for this hunk? */
  feedHz?: number;
  activeKenyon: number;
  familiarized: number;
};
export type SequenceReading = {
  /** Index of the hunk whose novelty MBONs answered loudest on the readout pass. */
  looked: number;
  familiarity: number;
  readings: number;
  hunks: HunkReading[];
};
export type FlyVerdict = {
  verdict: 'changes_requested' | 'no_objection' | 'abstain';
  score: number;
  /** What the body did: reached (proboscis extended, MN9) or stayed still. */
  behavior: 'reached' | 'still';
  explanation: string;
};

const stimulusLine = (stimuli: Record<string, number>) =>
  Object.entries(stimuli)
    .filter(([, hz]) => hz > 0)
    .map(([name, hz]) => `${name}=${hz.toFixed(2)}`)
    .join(',') || 'none';

export type BrainOptions = {
  seed?: number;
  gain?: number;
  memoryPath?: string | null;
  lesson?: Lesson;
  rate?: number;
  /** Wiring ablation, e.g. "dan-mbon:1", "kc-mbon:3", "mbon-out:2", or several comma-separated. Never used by the page. */
  shuffle?: string | null;
};
const SHUFFLE_SPEC = /^(dan-mbon|kc-mbon|mbon-out)(:\d{1,9})?(,(dan-mbon|kc-mbon|mbon-out)(:\d{1,9})?)*$/;

/**
 * A review: Jev's descriptors and the changed text become an odor; the odor code runs through the mushroom body with
 * the fly's current memory; the MBONs answer. With a lesson, the same run also changes the memory (dopamine).
 */
export async function reviewBrain(
  descriptors: Descriptors,
  changedText: string,
  options: BrainOptions = {},
): Promise<ReviewBrain> {
  parseDescriptors(descriptors);
  const odor = odorize(descriptors, changedText);
  return smellBrain(odor, options);
}
/** Present an odor directly (the calibration and leave-one-out scripts use this with cached descriptors). */
export async function smellBrain(odor: Odor, options: BrainOptions = {}): Promise<ReviewBrain> {
  const { seed = 7, gain = 0.65, memoryPath = MEMORY_PATH, lesson = 'none', rate = 0.6, shuffle = null } = options;
  if (!Number.isSafeInteger(seed) || ![0, 0.65].includes(gain)) throw new Error('Invalid review assay settings');
  if (!['none', 'punish', 'reward'].includes(lesson)) throw new Error('Invalid lesson');
  if (Object.keys(odor).some(k => !k.startsWith('odor:ORN_'))) throw new Error('An odor is a set of glomerulus rates');
  const reading = await runBridge([seed, gain, stimulusLine(odor), lesson, rate].join('\t'), memoryPath, shuffle);
  return { ...reading, seed, gain, rates: Object.values(odor), stimuli: odor };
}

export type SequenceOptions = {
  seed?: number;
  gain?: number;
  memoryPath?: string | null;
  /** Exposure-driven depression of KC → α'3 synapses per presentation. */
  familiarity?: number;
  /** Reading passes before the frozen readout pass. */
  readings?: number;
  shuffle?: string | null;
};
/**
 * Read a diff hunk by hunk. The fly reads the sequence once (each puff familiarizes its smell), then reads it again with
 * those synapses frozen; the readout is order-independent and the hunk whose novelty MBONs stay loudest is the one it
 * looked at. Valence readouts are taken per hunk against the same long-term memory a single smell would use. Nothing
 * here writes to that memory.
 */
export async function smellSequence(odors: Odor[], options: SequenceOptions = {}): Promise<ReviewBrain> {
  const { seed = 7, gain = 0.65, memoryPath = MEMORY_PATH, familiarity = 0.3, readings = 1, shuffle = null } = options;
  if (!Number.isSafeInteger(seed) || ![0, 0.65].includes(gain)) throw new Error('Invalid review assay settings');
  if (!Array.isArray(odors) || odors.length < 1 || odors.length > 64) throw new Error('A sequence holds 1 to 64 odors');
  if (!(familiarity >= 0 && familiarity <= 1) || !Number.isInteger(readings) || readings < 0 || readings > 3)
    throw new Error('Invalid familiarity settings');
  for (const odor of odors)
    if (Object.keys(odor).some(k => !k.startsWith('odor:ORN_')))
      throw new Error('An odor is a set of glomerulus rates');
  const header = [seed, gain, 'sequence', odors.length, familiarity, readings].join('\t');
  const reading = await runBridge([header, ...odors.map(stimulusLine)].join('\n'), memoryPath, shuffle);
  const sequence = (reading as { sequence?: SequenceReading }).sequence;
  if (
    !sequence ||
    !Array.isArray(sequence.hunks) ||
    sequence.hunks.length !== odors.length ||
    !Number.isInteger(sequence.looked) ||
    sequence.looked < 0 ||
    sequence.looked >= odors.length ||
    sequence.hunks.some(
      (h, i) =>
        h.index !== i ||
        ![h.avoidHz, h.approachHz, h.noveltyHz, h.naiveNoveltyHz, h.familiarity, h.activeKenyon, h.familiarized].every(
          n => Number.isFinite(n) && n >= 0,
        ),
    )
  )
    throw new Error('Invalid sequence reading');
  const looked = odors[sequence.looked];
  return { ...reading, seed, gain, rates: Object.values(looked), stimuli: looked, sequence };
}

/** Stimulate named sensory populations directly (no code, no Jev) and record the same way a review is recorded. */
export async function pokeBrain(
  stimuli: PokeStimuli,
  seed = 7,
  gain = 0.65,
  memoryPath: string | null = MEMORY_PATH,
): Promise<ReviewBrain> {
  const parsed = parsePokeStimuli(stimuli);
  if (!Number.isSafeInteger(seed) || ![0, 0.65].includes(gain)) throw new Error('Invalid poke settings');
  const reading = await runBridge([seed, gain, stimulusLine(parsed), 'none'].join('\t'), memoryPath);
  return { ...reading, seed, gain, rates: Object.values(parsed), stimuli: parsed };
}

async function runBridge(
  line: string,
  memoryPath: string | null,
  shuffle: string | null = null,
): Promise<Omit<ReviewBrain, 'seed' | 'gain' | 'rates'>> {
  if (shuffle !== null && !SHUFFLE_SPEC.test(shuffle)) throw new Error('Invalid wiring ablation');
  const config = JSON.parse(await readFile(join(ROOT, '.runtime/config.json'), 'utf8')) as { java: string };
  const output = await command(
    config.java,
    [
      '-Xmx512m',
      '-cp',
      join(ROOT, '.runtime/classes'),
      'ReviewBrainBridge',
      join(ROOT, 'data/malecns-v1.0.flyb.gz'),
      ...(memoryPath ? [memoryPath] : []),
      ...(shuffle ? [`--shuffle=${shuffle}`] : []),
    ],
    line + '\n',
    // A sequence runs three trials per hunk, the first with plasticity on; 32 hunks is one to two minutes.
    line.includes('\tsequence\t') ? 240_000 : 60_000,
  );
  const lines = output.trim().split('\n');
  if (lines.length !== 2) throw new Error('Malformed review assay output');
  const metadata = JSON.parse(lines[0]);
  const result = JSON.parse(lines[1]);
  if (metadata.neurons !== 176422 || metadata.connections !== 6287749)
    throw new Error('Unexpected connectome metadata');
  if (
    !Array.isArray(metadata.geometry3d) ||
    !metadata.geometry3d.length ||
    metadata.geometry3d.length > 8000 ||
    metadata.geometry3d.some((p: number[]) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))
  )
    throw new Error('Invalid 3D anatomy; rerun npm run setup');
  if (
    !Array.isArray(metadata.links3d) ||
    metadata.links3d.length > 1600 ||
    metadata.links3d.some((p: number[]) => !Array.isArray(p) || p.length !== 9 || !p.every(Number.isFinite) || p[2] < 5)
  )
    throw new Error('Invalid sampled connectivity');
  const readouts = metadata.readouts3d as unknown;
  if (
    !Array.isArray(readouts) ||
    readouts.length !== 3 ||
    readouts.some(
      population =>
        !Array.isArray(population) ||
        !population.length ||
        population.length > 50 ||
        population.some((p: number[]) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)),
    )
  )
    throw new Error('Invalid readout anatomy; rerun npm run setup');
  if (
    !Array.isArray(metadata.readoutSizes) ||
    metadata.readoutSizes.length !== 3 ||
    metadata.readoutSizes.some(
      (n: unknown, i: number) => typeof n !== 'number' || n < (readouts as Point3[][])[i].length,
    )
  )
    throw new Error('Invalid readout population sizes');
  for (const key of [
    'feedHz',
    'groomHz',
    'escapeHz',
    'avoidHz',
    'approachHz',
    'noveltyHz',
    'ppl1Hz',
    'pamHz',
    'activeKenyon',
    'depressed',
    'rememberedSynapses',
    'spikes',
    'wallMs',
    'simulatedMs',
  ])
    if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error('Invalid neural reading');
  const teaching = result.teaching as Teaching | null | undefined;
  if (result.lesson !== 'none') {
    if (
      !teaching ||
      !['bitter+ppl1', 'sugar+pam'].includes(teaching.pathway) ||
      ![teaching.ppl1Spikes, teaching.pamSpikes, teaching.alphaPrime3Spikes].every(
        n => Number.isInteger(n) && n >= 0,
      ) ||
      typeof teaching.compartments !== 'object' ||
      Object.values(teaching.compartments).some(
        c =>
          !['avoid', 'approach', 'novelty'].includes(c.group) ||
          !Number.isInteger(c.depressed) ||
          c.depressed < 0 ||
          !(c.meanFactor >= 0 && c.meanFactor <= 1) ||
          !(c.dopamine >= 0 && c.dopamine <= 1),
      ) ||
      Object.values(teaching.compartments).reduce((n, c) => n + c.depressed, 0) !== result.depressed
    )
      throw new Error('Invalid teaching receipt');
  } else if (teaching) throw new Error('An ordinary review reported a lesson');
  if (metadata.shuffle !== (shuffle ?? null)) throw new Error('The bridge did not apply the requested wiring ablation');
  if (!Array.isArray(result.activeKenyonIds) || result.activeKenyonIds.length !== result.activeKenyon)
    throw new Error('Invalid odor code');
  const mb = metadata.mushroomBody;
  if (
    !mb ||
    typeof mb !== 'object' ||
    [
      mb.kenyonCells,
      mb.avoidMbons,
      mb.approachMbons,
      mb.noveltyMbons,
      mb.plasticSynapses,
      mb.rememberedSynapses,
      mb.kcMbonScale,
    ].some(n => !Number.isFinite(n) || n < 0) ||
    !mb.dopamine ||
    [mb.dopamine.ppl1, mb.dopamine.pam, mb.dopamine.alphaPrime3, mb.dopamine.compartments].some(
      n => !Number.isInteger(n) || n <= 0,
    )
  )
    throw new Error('Invalid mushroom body metadata; rerun npm run setup');
  if (
    !Array.isArray(result.frames) ||
    result.frames.length !== 10 ||
    result.frames.some(
      (f: ReviewFrame, i: number) =>
        f.timeMs !== 225 + 25 * i ||
        ![f.feedHz, f.groomHz, f.escapeHz, f.spikes, ...f.inputSpikes].every(n => Number.isFinite(n) && n >= 0),
    )
  )
    throw new Error('Invalid recorded neural frames');
  for (const frame of result.frames as ReviewFrame[]) {
    if (
      !Array.isArray(frame.activity3d) ||
      frame.activity3d.length !== frame.activity.length ||
      frame.activity3d.some(
        (p, i) =>
          p.length !== 4 ||
          !p.every(Number.isFinite) ||
          p[3] <= 0 ||
          JSON.stringify([p[0], p[2], p[3]]) !== JSON.stringify(frame.activity[i]),
      )
    )
      throw new Error('3D activity does not match the measured 2D projection');
    if (
      !Array.isArray(frame.readoutCounts) ||
      frame.readoutCounts.length !== 3 ||
      frame.readoutCounts.some(
        (counts, i) =>
          !Array.isArray(counts) ||
          counts.length !== (readouts as Point3[][])[i].length ||
          counts.some(n => !Number.isInteger(n) || n < 0),
      )
    )
      throw new Error('Readout spike counts do not match the readout anatomy');
  }
  if (
    !metadata.pokes ||
    typeof metadata.pokes !== 'object' ||
    Object.values(metadata.pokes).some(n => typeof n !== 'number' || n <= 0)
  )
    throw new Error('Invalid population sizes; rerun npm run setup');
  return { ...metadata, ...result };
}

export const READOUT_CHANNELS = [
  { key: 'A', name: 'feeding', population: 'MN9', ceiling: 90 },
  { key: 'B', name: 'grooming', population: 'DNg62', ceiling: 200 },
  { key: 'C', name: 'escape', population: 'DNp01', ceiling: 480 },
] as const;
export type ChannelDiagnosis = {
  channels: {
    key: 'A' | 'B' | 'C';
    name: string;
    population: string;
    hz: number;
    ceiling: number;
    share: number;
    silent: boolean;
  }[];
  /** Mushroom body output for this trial. */
  mushroom: { avoidHz: number; approachHz: number; share: number; activeKenyon: number; rememberedSynapses: number };
  summary: string;
};

/** What the motor channels and the mushroom body did in one trial, and how the rule read it. Derived from the measurement. */
export function channelDiagnosis(
  brain: Pick<
    ReviewBrain,
    'feedHz' | 'groomHz' | 'escapeHz' | 'avoidHz' | 'approachHz' | 'activeKenyon' | 'rememberedSynapses'
  >,
): ChannelDiagnosis {
  const rates = [brain.feedHz, brain.groomHz, brain.escapeHz];
  const channels = READOUT_CHANNELS.map((channel, i) => ({
    ...channel,
    hz: rates[i],
    share: rates[i] / channel.ceiling,
    silent: rates[i] === 0,
  }));
  const total = brain.avoidHz + brain.approachHz;
  const share = total > 0 ? brain.avoidHz / total : 0.5;
  const memory =
    brain.rememberedSynapses > 0
      ? `${brain.rememberedSynapses.toLocaleString()} synapses carry memory.`
      : 'The fly has no memory yet.';
  const reading =
    total < VERDICT_RULE.minimumHz
      ? 'the mushroom body barely answered'
      : share >= VERDICT_RULE.objection
        ? `avoidance won (share ${share.toFixed(2)}, objection line ${VERDICT_RULE.objection})`
        : share <= VERDICT_RULE.approval
          ? `approach won (share ${share.toFixed(2)}, approval line ${VERDICT_RULE.approval})`
          : `neither won (share ${share.toFixed(2)}, between ${VERDICT_RULE.approval} and ${VERDICT_RULE.objection})`;
  const body =
    brain.feedHz >= VERDICT_RULE.reachHz
      ? `Proboscis motor neurons ${brain.feedHz.toFixed(0)} Hz: it reached for the smell.`
      : 'Proboscis motor neurons silent: the body stayed still.';
  const summary = `${brain.activeKenyon} Kenyon cells carried this odor. Avoidance MBONs ${brain.avoidHz.toFixed(0)} Hz against approach ${brain.approachHz.toFixed(0)} Hz: ${reading}. ${body} ${memory}`;
  return {
    channels,
    mushroom: {
      avoidHz: brain.avoidHz,
      approachHz: brain.approachHz,
      share,
      activeKenyon: brain.activeKenyon,
      rememberedSynapses: brain.rememberedSynapses,
    },
    summary,
  };
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, ROOT } from './io.ts';

export const FEATURE_KEYS = ['externalInput', 'persistentData', 'timing', 'visibleBehavior'] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];
export type Features = Record<FeatureKey, number>;
export type Point3 = [number, number, number];
export type ActivePoint3 = [number, number, number, number];
/** [pre body ID, post body ID, synapse count, pre x/y/z, post x/y/z]. */
export type Link3 = [number, number, number, number, number, number, number, number, number];
export type BrainAnatomy = { neurons: number; connections: number; geometry3d: Point3[]; links3d: Link3[] };
export type ReviewFrame = { timeMs: number; feedHz: number; groomHz: number; escapeHz: number; spikes: number; inputSpikes: number[]; activity: [number, number, number][]; activity3d?: ActivePoint3[] };
export type ReviewBrain = {
  neurons: number; connections: number; groups: number[]; projection: [number, number][];
  geometry3d?: Point3[]; links3d?: Link3[];
  feedHz: number; groomHz: number; escapeHz: number; spikes: number; wallMs: number; simulatedMs: number;
  frames: ReviewFrame[]; activity: [number, number, number][];
  seed: number; gain: number; rates: number[];
};
export type FlyVerdict = { verdict: 'changes_requested' | 'no_objection' | 'abstain'; score: number; explanation: string };

export function parseFeatures(value: unknown): Features {
  if (!value || typeof value !== 'object') throw new Error('Expected four feature probabilities');
  const f = value as Features;
  if (Object.keys(f).length !== 4 || FEATURE_KEYS.some(k => typeof f[k] !== 'number' || !Number.isFinite(f[k]) || f[k] < 0 || f[k] > 1)) throw new Error('Features must be probabilities between zero and one');
  return Object.fromEntries(FEATURE_KEYS.map(k => [k, f[k]])) as Features;
}

export async function reviewBrain(features: Features, seed = 7, gain = .65): Promise<ReviewBrain> {
  parseFeatures(features);
  if (!Number.isSafeInteger(seed) || ![0, .65].includes(gain)) throw new Error('Invalid review assay settings');
  const config = JSON.parse(await readFile(join(ROOT, '.runtime/config.json'), 'utf8')) as { java: string };
  const rates = FEATURE_KEYS.map(key => features[key] * 180);
  const output = await command(config.java, ['-Xmx512m', '-cp', join(ROOT, '.runtime/classes'), 'ReviewBrainBridge', join(ROOT, 'data/malecns-v1.0.flyb.gz')], [seed, ...rates, gain].join('\t') + '\n', 45_000);
  const lines = output.trim().split('\n');
  if (lines.length !== 2) throw new Error('Malformed review assay output');
  const metadata = JSON.parse(lines[0]);
  const result = JSON.parse(lines[1]);
  if (metadata.neurons !== 176422 || metadata.connections !== 6287749 || !Array.isArray(metadata.groups) || metadata.groups.length !== 4 || metadata.groups.some((n: unknown) => typeof n !== 'number' || n <= 0)) throw new Error('Unexpected connectome metadata');
  if (!Array.isArray(metadata.geometry3d) || !metadata.geometry3d.length || metadata.geometry3d.length > 8000 || metadata.geometry3d.some((p: number[]) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))) throw new Error('Invalid 3D anatomy; rerun npm run setup');
  if (!Array.isArray(metadata.links3d) || metadata.links3d.length > 1600 || metadata.links3d.some((p: number[]) => !Array.isArray(p) || p.length !== 9 || !p.every(Number.isFinite) || p[2] < 5)) throw new Error('Invalid sampled connectivity');
  for (const key of ['feedHz', 'groomHz', 'escapeHz', 'spikes', 'wallMs', 'simulatedMs']) if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error('Invalid neural reading');
  if (!Array.isArray(result.frames) || result.frames.length !== 10 || result.frames.some((f: ReviewFrame, i: number) => f.timeMs !== 225 + 25 * i || ![f.feedHz, f.groomHz, f.escapeHz, f.spikes, ...f.inputSpikes].every(n => Number.isFinite(n) && n >= 0))) throw new Error('Invalid recorded neural frames');
  for (const frame of result.frames as ReviewFrame[]) {
    if (!Array.isArray(frame.activity3d) || frame.activity3d.length !== frame.activity.length || frame.activity3d.some((p, i) => p.length !== 4 || !p.every(Number.isFinite) || p[3] <= 0 || JSON.stringify([p[0], p[2], p[3]]) !== JSON.stringify(frame.activity[i]))) throw new Error('3D activity does not match the measured 2D projection');
  }
  return { ...metadata, ...result, seed, gain, rates };
}

/** Untrained, published readout. These outputs do not biologically mean code quality. */
export function reviewVerdict(brain: Pick<ReviewBrain, 'feedHz' | 'groomHz' | 'escapeHz'>): FlyVerdict {
  if (![brain.feedHz, brain.groomHz, brain.escapeHz].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid neural readout');
  const total = brain.feedHz + brain.groomHz + brain.escapeHz;
  if (total < 20) return { verdict: 'abstain', score: 0, explanation: 'Downstream output was too weak to produce a verdict.' };
  // Normalize for the very different firing ranges of the three populations.
  const objection = brain.groomHz / 200 + brain.escapeHz / 480;
  const acceptance = brain.feedHz / 90;
  const score = objection / Math.max(.001, objection + acceptance);
  return score >= .65
    ? { verdict: 'changes_requested', score, explanation: 'Normalized grooming/escape readout exceeded our 0.65 objection threshold. This is a neural classification, not a bug explanation.' }
    : { verdict: 'no_objection', score, explanation: 'The objection readout did not cross our 0.65 threshold. This does not establish that the code is correct.' };
}

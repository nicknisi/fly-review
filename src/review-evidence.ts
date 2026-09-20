import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { RUNS_ROOT } from './io.ts';
import type { ReviewState } from './review-types.ts';
import type { ReviewBrain } from './review-brain.ts';

export type OdorMatch = {
  id: string;
  title: string;
  lesson: string;
  status: string;
  shared: number;
  total: number;
  overlap: number;
};
export function odorOverlap(a: number[], b: number[]) {
  const left = new Set(a),
    right = new Set(b);
  const shared = [...left].filter(id => right.has(id)).length;
  const total = new Set([...left, ...right]).size;
  return { shared, total, overlap: total ? shared / total : 1 };
}

/** Receipt IDs, never caller-supplied paths. Symlinked bundles/files are not exportable. */
async function bundleFile(id: unknown, filename: string, root: string): Promise<string> {
  if (typeof id !== 'string' || !/^(review|poke)-[a-zA-Z0-9]{6}$/.test(id))
    throw new Error('Invalid evidence bundle ID');
  const dir = join(root, id),
    file = join(dir, filename);
  if ((await lstat(dir)).isSymbolicLink() || (await lstat(file)).isSymbolicLink())
    throw new Error('Symlinked evidence is not exportable');
  const resolved = await realpath(file),
    allowed = await realpath(root);
  if (!resolved.startsWith(allowed + sep) || (await lstat(file)).size > 8_000_000)
    throw new Error('Invalid evidence file');
  return resolved;
}
async function readReview(id: string, root: string): Promise<ReviewState> {
  return JSON.parse(await readFile(await bundleFile(id, 'review.json', root), 'utf8')) as ReviewState;
}

function measuredReceipt(brain: ReviewBrain) {
  return {
    seed: brain.seed,
    gain: brain.gain,
    avoidHz: brain.avoidHz,
    approachHz: brain.approachHz,
    feedHz: brain.feedHz,
    groomHz: brain.groomHz,
    escapeHz: brain.escapeHz,
    activeKenyon: brain.activeKenyon,
    rememberedSynapses: brain.rememberedSynapses,
    frames: brain.frames.map(({ timeMs, avoidHz, approachHz, feedHz, groomHz, escapeHz, inputSpikes }) => ({
      timeMs,
      avoidHz,
      approachHz,
      feedHz,
      groomHz,
      escapeHz,
      inputSpikes,
    })),
  };
}

export async function readReceipt(id: unknown, root = RUNS_ROOT) {
  if (typeof id !== 'string') throw new Error('Invalid evidence bundle ID');
  if (id.startsWith('poke-')) {
    const recording = JSON.parse(await readFile(await bundleFile(id, 'poke.json', root), 'utf8'));
    return {
      id,
      kind: 'sensory',
      at: recording.at,
      stimuli: recording.stimuli,
      memoryInput: recording.memoryInput,
      measurements: measuredReceipt(recording.brain),
    };
  }
  const state = await readReview(id, root);
  return {
    id,
    kind: 'review',
    title: state.review.title,
    phase: state.phase,
    explanation: state.explanation,
    seed: state.brain?.seed,
    odor: state.odor,
    memoryInput: state.memoryInput,
    verdict: state.verdict,
    verification: state.verification,
    lesson: state.lesson,
    history: state.history,
    memoryComparison: state.memoryComparison
      ? {
          memoryInput: state.memoryComparison.memoryInput,
          current: measuredReceipt(state.memoryComparison.current),
          naive: measuredReceipt(state.memoryComparison.naive),
        }
      : null,
  };
}

export async function odorLineup(
  state: ReviewState,
  root = RUNS_ROOT,
): Promise<{ matches: OdorMatch[]; unavailable: number }> {
  const matches: OdorMatch[] = [];
  let unavailable = 0;
  const current = state.brain?.activeKenyonIds;
  if (!current?.length) return { matches, unavailable: state.memory.lessons.length };
  const seen = new Set<string>();
  for (const lesson of state.memory.lessons) {
    const id = lesson.runDir ? basename(lesson.runDir) : '';
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const other = await readReview(id, root);
      const ids = other.brain?.activeKenyonIds;
      if (
        other.odorCodeVersion !== state.odorCodeVersion ||
        !Array.isArray(ids) ||
        !ids.length ||
        !ids.every(Number.isFinite)
      ) {
        unavailable++;
        continue;
      }
      matches.push({
        id,
        title: other.review.title,
        lesson: lesson.lesson,
        status: other.verification?.status ?? 'unavailable',
        ...odorOverlap(current, ids),
      });
    } catch (error) {
      // Missing/legacy/incompatible receipts are explicitly unavailable, never zero-similarity evidence.
      if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      unavailable++;
    }
  }
  return {
    matches: matches.sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id)).slice(0, 3),
    unavailable,
  };
}

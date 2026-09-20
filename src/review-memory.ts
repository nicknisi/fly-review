import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJSON, hash } from './io.ts';
import { MEMORY_PATH } from './review-brain.ts';
import type { Lesson } from './review-brain.ts';

export type MemorySnapshot = { path: string; hash: string; rememberedSynapses: number };
export type LessonEntry = {
  at: string;
  runDir: string | null;
  caseId: string;
  title: string;
  lesson: Exclude<Lesson, 'none'>;
  reason: string;
  activeKenyon: number;
  depressed: number;
  rememberedSynapses: number;
  beforeHash?: string;
  afterHash?: string;
  /** Where the lesson came from: a verification on the page, or bulk training from executed cases. */
  source?: 'verification' | 'training';
  /** The Kenyon cells that carried this odor, so a later smell can be compared with what was taught. */
  kenyonIds?: number[];
  smell?: string;
  /** How the lesson was delivered and what the fly's dopamine neurons did with it (absent on lessons before this rule). */
  teaching?: TeachingSummary;
};
/** A lesson's receipt, condensed: the taste, the dopamine neurons' firing, and where the depression landed. */
export type TeachingSummary = {
  pathway: 'bitter+ppl1' | 'sugar+pam';
  ppl1Hz: number;
  pamHz: number;
  /** Proboscis motor neuron rate during the lesson: sugar opens it, bitter does not. */
  feedHz: number;
  /** Synapses depressed, by the readout group of the MBON they land on. */
  byGroup: { avoid: number; approach: number; novelty: number };
  /** The compartments (MBON types) that saw the most dopamine, strongest first. */
  compartments: { mbon: string; group: 'avoid' | 'approach' | 'novelty'; dopamine: number; depressed: number }[];
};
export function summarizeTeaching(brain: {
  teaching?: {
    pathway: string;
    compartments: Record<string, { group: 'avoid' | 'approach' | 'novelty'; depressed: number; dopamine: number }>;
  } | null;
  ppl1Hz?: number;
  pamHz?: number;
  feedHz: number;
}): TeachingSummary | undefined {
  const t = brain.teaching;
  if (!t || (t.pathway !== 'bitter+ppl1' && t.pathway !== 'sugar+pam')) return undefined;
  const byGroup = { avoid: 0, approach: 0, novelty: 0 };
  for (const c of Object.values(t.compartments)) byGroup[c.group] += c.depressed;
  const compartments = Object.entries(t.compartments)
    .map(([mbon, c]) => ({ mbon, group: c.group, dopamine: c.dopamine, depressed: c.depressed }))
    .sort((a, b) => b.dopamine - a.dopamine || b.depressed - a.depressed)
    .slice(0, 6);
  return {
    pathway: t.pathway,
    ppl1Hz: brain.ppl1Hz ?? 0,
    pamHz: brain.pamHz ?? 0,
    feedHz: brain.feedHz,
    byGroup,
    compartments,
  };
}
/** One sentence a person can read about what a lesson did inside the fly. */
export function describeTeaching(
  lesson: Exclude<Lesson, 'none'>,
  t: TeachingSummary | undefined,
  depressed: number,
  activeKenyon: number,
): string {
  if (!t)
    return `${activeKenyon} Kenyon cells carried this odor; ${depressed.toLocaleString()} of their synapses were depressed.`;
  const taste = lesson === 'punish' ? 'Bitter on its proboscis' : 'Sugar on its proboscis';
  const dan =
    lesson === 'punish'
      ? `its PPL1 dopamine neurons fired at ${t.ppl1Hz.toFixed(0)} Hz`
      : `its PAM dopamine neurons fired at ${t.pamHz.toFixed(0)} Hz`;
  const landing =
    lesson === 'punish'
      ? `${t.byGroup.approach.toLocaleString()} onto approach MBONs, ${t.byGroup.avoid.toLocaleString()} onto avoidance`
      : `${t.byGroup.avoid.toLocaleString()} onto avoidance MBONs, ${t.byGroup.approach.toLocaleString()} onto approach`;
  const where = t.compartments
    .slice(0, 3)
    .map(c => `${c.mbon} (${c.group}, dopamine ${c.dopamine.toFixed(2)})`)
    .join(', ');
  return `${taste} while it smelled this: ${dan}, and ${depressed.toLocaleString()} synapses of the ${activeKenyon} Kenyon cells carrying the odor were depressed where that dopamine landed (${landing}). Most dopamine reached ${where}. The wiring chose those compartments; ${lesson === 'punish' ? "bitter reached PPL1 through the fly's own circuits, topped up with direct drive" : 'sugar never reaches PAM in this model, so the PAM cells were driven directly'}.`;
}
export type Memory = { rememberedSynapses: number; lessons: LessonEntry[] };
type StoredMemory = { edges: [number, number][]; lessons?: LessonEntry[] };
const LOG_PATH = join(dirname(MEMORY_PATH), 'memory-log.jsonl');
export const emptyMemory = (): Memory => ({ rememberedSynapses: 0, lessons: [] });

async function readMemory(path: string | null, missingIsNaive = false): Promise<StoredMemory> {
  if (path === null) return { edges: [] };
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (missingIsNaive && (error as NodeJS.ErrnoException).code === 'ENOENT') return { edges: [] };
    throw error;
  }
  const data = JSON.parse(raw) as StoredMemory;
  if (
    !data ||
    !Array.isArray(data.edges) ||
    data.edges.some(
      edge =>
        !Array.isArray(edge) ||
        edge.length !== 2 ||
        !Number.isSafeInteger(edge[0]) ||
        edge[0] < 0 ||
        edge[0] >= 6_287_749 || // Global graph-edge IDs, not offsets within the plastic-edge list.
        !Number.isFinite(edge[1]) ||
        edge[1] < 0 ||
        edge[1] > 1,
    ) ||
    new Set(data.edges.map(edge => edge[0])).size !== data.edges.length
  )
    throw new Error('Invalid synaptic memory; refusing to invent a naive state');
  if (data.lessons !== undefined && !Array.isArray(data.lessons)) throw new Error('Invalid memory provenance');
  data.edges.sort((a, b) => a[0] - b[0]);
  return data;
}
const memoryHash = (data: StoredMemory): string => hash(JSON.stringify({ edges: data.edges }));

/** The hash identifies factors, not the filename or lesson metadata. A naive state is an explicit empty edge list. */
export async function snapshotMemory(
  source: string | null,
  destination: string,
  missingIsNaive = false,
): Promise<MemorySnapshot> {
  const data = await readMemory(source, missingIsNaive);
  await atomicJSON(destination, { edges: data.edges }, 0);
  return { path: destination, hash: memoryHash(data), rememberedSynapses: data.edges.length };
}
export async function checkSnapshot(snapshot: MemorySnapshot): Promise<string> {
  if (memoryHash(await readMemory(snapshot.path)) !== snapshot.hash)
    throw new Error('Saved memory hash does not match; refusing replay');
  return snapshot.path;
}

/** New memories carry their lessons in the same atomic file. Old two-file memories migrate on the next lesson. */
export async function loadMemoryLog(path = MEMORY_PATH): Promise<LessonEntry[]> {
  const data = await readMemory(path, true);
  if (data.lessons) return data.lessons;
  if (path !== MEMORY_PATH) return [];
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as LessonEntry);
}

async function withMemoryLock(path: string, action: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Memory update is locked at ${lockPath}. If its recorded process has stopped, inspect the prepared receipts before removing a stale lock.`,
      );
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await lock.sync();
    await action();
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

/** Publish factors and their provenance together. The bridge only teaches a run-local staging copy. */
export async function promoteMemory(
  after: MemorySnapshot,
  entry: LessonEntry,
  before: MemorySnapshot,
  path = MEMORY_PATH,
): Promise<void> {
  await withMemoryLock(path, async () => {
    const current = await readMemory(path, true);
    if (memoryHash(current) !== before.hash)
      throw new Error('Memory changed during teaching; saved lesson was not promoted');
    const lessons = await loadMemoryLog(path);
    const learned = await readMemory(after.path);
    if (memoryHash(learned) !== after.hash) throw new Error('Prepared memory hash does not match; refusing promotion');
    // Compact JSON is also the bridge's native memory format. One rename commits factors AND provenance.
    await atomicJSON(path, { edges: learned.edges, lessons: [...lessons, entry] }, 0);
  });
}

/** Replace the live memory wholesale with a trained one: factors and their lessons together, under the same lock. */
export async function installMemory(source: string, path = MEMORY_PATH): Promise<{ edges: number; lessons: number }> {
  const data = await readMemory(source);
  const lessons = data.lessons ?? [];
  await withMemoryLock(path, async () => {
    await atomicJSON(path, { edges: data.edges, lessons }, 0);
    if (path === MEMORY_PATH) await rm(LOG_PATH, { force: true });
  });
  return { edges: data.edges.length, lessons: lessons.length };
}

/** Historical run snapshots survive forgetting. Only the current fly and legacy log are removed. */
export async function resetMemory(path = MEMORY_PATH): Promise<void> {
  await withMemoryLock(path, async () => {
    // An explicit naive file is authoritative even if removing a legacy log is interrupted.
    await atomicJSON(path, { edges: [], lessons: [] }, 0);
    if (path === MEMORY_PATH) await rm(LOG_PATH, { force: true });
  });
}

/** Decide what, if anything, a verification outcome teaches. Unknown stays unknown. */
export function lessonFor(
  status: 'confirmed' | 'unsubstantiated' | 'inconclusive',
  control: boolean,
): { lesson: Lesson; reason: string } {
  if (status === 'confirmed')
    return { lesson: 'punish', reason: 'A regression was reproduced by execution: this odor preceded punishment.' };
  if (status === 'unsubstantiated' && control)
    return {
      lesson: 'reward',
      reason: 'A designated behavior-preserving control that the sweep could not fault: this odor preceded reward.',
    };
  if (status === 'unsubstantiated')
    return {
      lesson: 'none',
      reason:
        'No regression was found, but that is not proof of correctness and this change is not a designated control. Unknown stays unknown.',
    };
  return {
    lesson: 'none',
    reason: 'The original failed its own contract; nothing can be attributed, so nothing is taught.',
  };
}

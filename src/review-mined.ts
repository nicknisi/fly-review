import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './io.ts';
import { REVIEW_CASES } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';

/**
 * The mined corpus: changes to real TypeScript repositories whose labels were proven by those repositories' own test
 * suites (review-mutate.ts). One file per repository under data/mined/. Like the grown corpus, it exists to teach the
 * fly in bulk; unlike it, the code is real and the tests are the repository's.
 */
export const MINED_DIR = join(ROOT, 'data/mined');

export function validateMinedCase(value: unknown): ReviewCase {
  if (!value || typeof value !== 'object') throw new Error('Mined case is not an object');
  const c = value as ReviewCase;
  const text = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Mined case ${String(c.id)}: ${what} missing`);
  };
  text(c.id, 'id');
  for (const field of ['title', 'group', 'filename', 'context', 'before', 'after', 'functionName'] as const)
    text(c[field], field);
  if (c.contract !== null || c.oracle !== null) throw new Error(`Mined case ${c.id}: has no contract and no oracle`);
  if (c.before === c.after) throw new Error(`Mined case ${c.id}: before and after are identical`);
  const m = c.mined;
  if (!m || typeof m !== 'object') throw new Error(`Mined case ${c.id}: provenance`);
  for (const field of ['repo', 'commit', 'file', 'family', 'at'] as const) text(m[field], `mined.${field}`);
  if (m.kind === 'mutant') {
    text(m.mutator, 'mined.mutator');
    if (!Array.isArray(m.killedBy) || m.killedBy.length === 0 || m.killedBy.some(t => typeof t !== 'string'))
      throw new Error(`Mined case ${c.id}: a mutant must name the tests that killed it`);
    if (c.control) throw new Error(`Mined case ${c.id}: a killed mutant cannot be a control`);
  } else if (m.kind === 'rewrite') {
    text(m.rewrite, 'mined.rewrite');
    if (c.control !== true) throw new Error(`Mined case ${c.id}: a verified rewrite must be designated a control`);
    if (!m.verified || !m.verified.typecheck || !(m.verified.tests > 0) || typeof m.verified.suite !== 'string')
      throw new Error(`Mined case ${c.id}: a rewrite must record the suite that passed with it`);
  } else throw new Error(`Mined case ${c.id}: kind`);
  if (REVIEW_CASES.some(r => r.id === c.id)) throw new Error(`Mined case ${c.id} collides with a bundled example`);
  return c;
}

export async function loadMinedCases(dir = MINED_DIR): Promise<ReviewCase[]> {
  let files: string[];
  try {
    // One corpus per repository; the mining summary written beside it (<repo>.summary.json) is provenance, not cases.
    files = (await readdir(dir)).filter(f => f.endsWith('.json') && !f.endsWith('.summary.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const cases: ReviewCase[] = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown;
    if (!Array.isArray(data)) throw new Error(`${file}: mined corpus is not an array`);
    cases.push(...data.map(validateMinedCase));
  }
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Mined corpus has duplicate ids');
  return cases;
}

/**
 * The label a mined case was proven to carry. A killed mutant is a confirmed regression; a verified rewrite is a
 * change the suite could not fault. Mirrors labelByExecution's statuses so lessonFor applies unchanged.
 */
export function minedStatus(review: ReviewCase): 'confirmed' | 'unsubstantiated' {
  if (!review.mined) throw new Error(`${review.id} is not a mined case`);
  return review.mined.kind === 'mutant' ? 'confirmed' : 'unsubstantiated';
}

/** Cases that change the same function share a family; a family is held out or taught whole. */
export function familyOf(review: ReviewCase): string {
  if (review.mined) return `mined:${review.mined.repo}:${review.mined.family}`;
  if (review.grown) return `grown:${review.grown.scenario}`;
  return `bundled:${review.id}`;
}

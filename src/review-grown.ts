import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './io.ts';
import { REVIEW_CASES } from './review-cases.ts';
import type { ReviewCase } from './review-cases.ts';

/**
 * The grown corpus: cases drafted by a model and kept only when the harness proved their label by execution
 * (see review-grow.ts). They exist to teach the fly in bulk; the bundled examples stay the held-out set.
 */
export const GROWN_PATH = join(ROOT, 'data/grown-cases.json');

export function validateGrownCase(value: unknown): ReviewCase {
  if (!value || typeof value !== 'object') throw new Error('Grown case is not an object');
  const c = value as ReviewCase;
  const text = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Grown case ${String(c.id)}: ${what} missing`);
  };
  text(c.id, 'id');
  for (const field of [
    'title',
    'group',
    'filename',
    'context',
    'before',
    'after',
    'functionName',
    'contract',
    'reference',
  ] as const)
    text(c[field], field);
  if (c.oracle !== 'reference') throw new Error(`Grown case ${c.id}: oracle must be reference`);
  if (!Array.isArray(c.parameters) || c.parameters.length === 0) throw new Error(`Grown case ${c.id}: parameters`);
  if (!Array.isArray(c.sweep) || c.sweep.length === 0 || c.sweep.length > 50)
    throw new Error(`Grown case ${c.id}: sweep must hold 1 to 50 inputs`);
  if (typeof c.smell !== 'string') throw new Error(`Grown case ${c.id}: smell`);
  if (!c.grown || typeof c.grown.model !== 'string' || typeof c.grown.scenario !== 'string')
    throw new Error(`Grown case ${c.id}: provenance`);
  if (c.control !== undefined && c.control !== true) throw new Error(`Grown case ${c.id}: control flag`);
  if (REVIEW_CASES.some(r => r.id === c.id)) throw new Error(`Grown case ${c.id} collides with a bundled example`);
  return c;
}

export async function loadGrownCases(path = GROWN_PATH): Promise<ReviewCase[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error('Grown corpus is not an array');
  const cases = data.map(validateGrownCase);
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Grown corpus has duplicate ids');
  return cases;
}

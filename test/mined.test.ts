import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ReviewCase } from '../src/review-cases.ts';
import { familyOf, loadMinedCases, minedStatus, validateMinedCase } from '../src/review-mined.ts';

const mutant = (): ReviewCase => ({
  id: 'o-r-src-a-fn-m1',
  title: 'fn: === → !==',
  group: 'o/r',
  filename: 'src/a.ts',
  context: 'o/r, src/a.ts',
  before: 'export function fn(x: number) {\n  return x === 1;\n}',
  after: 'export function fn(x: number) {\n  return x !== 1;\n}',
  functionName: 'fn',
  contract: null,
  parameters: [],
  oracle: null,
  format: 'text',
  mined: {
    repo: 'o/r',
    commit: 'abc',
    file: 'src/a.ts',
    family: 'src/a.ts:fn',
    kind: 'mutant',
    mutator: 'EqualityOperator',
    killedBy: ['a.ts fn returns true for 1'],
    at: '2026-01-01T00:00:00.000Z',
  },
});
const rewrite = (): ReviewCase => ({
  ...mutant(),
  id: 'o-r-src-a-fn-rename-local',
  title: 'fn: rename x to value',
  after: 'export function fn(value: number) {\n  return value === 1;\n}',
  control: true,
  mined: {
    repo: 'o/r',
    commit: 'abc',
    file: 'src/a.ts',
    family: 'src/a.ts:fn',
    kind: 'rewrite',
    rewrite: 'rename-local',
    verified: { suite: 'vitest', tests: 420, typecheck: true },
    at: '2026-01-01T00:00:00.000Z',
  },
});

test('mined cases carry executed labels from the repository and are validated strictly', async () => {
  assert.equal(minedStatus(mutant()), 'confirmed', 'a killed mutant is a reproduced regression');
  assert.equal(minedStatus(rewrite()), 'unsubstantiated', 'a verified rewrite is a change the suite could not fault');
  assert.equal(familyOf(mutant()), familyOf(rewrite()), 'changes to one function share a family');
  assert.throws(() => validateMinedCase({ ...mutant(), control: true }), /cannot be a control/);
  assert.throws(() => validateMinedCase({ ...rewrite(), control: undefined }), /must be designated a control/);
  assert.throws(
    () => validateMinedCase({ ...mutant(), mined: { ...mutant().mined, killedBy: [] } }),
    /tests that killed/,
  );
  assert.throws(
    () =>
      validateMinedCase({
        ...rewrite(),
        mined: { ...rewrite().mined, verified: { suite: 'vitest', tests: 0, typecheck: true } },
      }),
    /record the suite/,
  );
  assert.throws(() => validateMinedCase({ ...mutant(), contract: 'x' }), /no contract/);
  assert.throws(() => validateMinedCase({ ...mutant(), after: mutant().before }), /identical/);
  const dir = await mkdtemp(join(tmpdir(), 'mined-'));
  try {
    await writeFile(join(dir, 'o-r.json'), JSON.stringify([mutant(), rewrite()]));
    const cases = await loadMinedCases(dir);
    assert.equal(cases.length, 2);
    await writeFile(join(dir, 'o-r2.json'), JSON.stringify([mutant()]));
    await assert.rejects(loadMinedCases(dir), /duplicate/);
    assert.deepEqual(await loadMinedCases(join(dir, 'missing')), [], 'no corpus yet is not an error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

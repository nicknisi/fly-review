import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequest } from '../src/review-github.ts';
import { HUNK_LIMITS, fileUnits, reviewUnits, splitHunks, unitState } from '../src/review-hunks.ts';
import { disclosurePayload } from '../src/review-show.ts';
import { pullRequestCase } from '../src/review-github.ts';

const pr = (files: PullRequest['files']): PullRequest => ({
  ref: { owner: 'o', repo: 'r', number: 1 },
  url: 'https://github.com/o/r/pull/1',
  title: 'T',
  body: 'B',
  author: 'a',
  base: 'main',
  head: 'abc',
  additions: 0,
  deletions: 0,
  changedFiles: files.length,
  files,
  shownPatchChars: 0,
  fetchedAt: 'now',
});
const file = (filename: string, patch: string | null, omitted?: string): PullRequest['files'][number] =>
  ({ filename, status: 'modified', additions: 1, deletions: 1, patch, ...(omitted ? { omitted } : {}) }) as never;

test('a pull request is split at its hunks with offsets that match the rendered diff', () => {
  const p = pr([
    file('a.ts', '@@ -1,2 +1,2 @@\n-x\n+y\n c\n@@ -9,1 +9,2 @@\n+z\n k'),
    file('lock.json', null, 'generated file'),
    file('b.ts', '@@ -1 +1 @@\n-p\n+q\n@@ patch truncated by fly-review @@'),
  ]);
  const units = splitHunks(p);
  assert.deepEqual(
    units.map(u => [u.filename, u.hunk, u.lines.from, u.lines.to, u.changed, u.additions, u.deletions]),
    [
      ['a.ts', 0, 0, 3, 'x\ny', 1, 1],
      ['a.ts', 1, 4, 6, 'z', 1, 0],
      ['b.ts', 0, 7, 9, 'p\nq', 1, 1],
    ],
  );
  assert.equal(units[0].patch, '@@ -1,2 +1,2 @@\n-x\n+y\n c');
  assert.equal(units[2].patch.includes('truncated'), false, 'the truncation marker is not part of any hunk');
  assert.deepEqual(reviewUnits(p), { units, granularity: 'hunk', skipped: 0 });
  const state = unitState(p, units[1]) as { hunk: string; patch: string; pullRequest: { title: string } };
  assert.equal(state.hunk, '@@ -9,1 +9,2 @@');
  assert.equal(state.pullRequest.title, 'T');
});

test('past the hunk limit whole files are the units, largest first, and the disclosure shows every request', () => {
  const many = pr(
    Array.from({ length: HUNK_LIMITS.units + 1 }, (_, i) => file(`f${i}.ts`, `@@ -1 +1 @@\n-a${i}\n+b${i}`)),
  );
  const plan = reviewUnits(many);
  assert.equal(plan.granularity, 'file');
  assert.equal(plan.units.length, HUNK_LIMITS.units);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(fileUnits(many).length, HUNK_LIMITS.units + 1);
  const disclosure = disclosurePayload(pullRequestCase(many)) as { note: string; requests: unknown[] };
  assert.match(disclosure.note, /32 separate requests, one per file/);
  assert.equal(disclosure.requests.length, HUNK_LIMITS.units);
  const single = disclosurePayload(pullRequestCase(pr([file('a.ts', '@@ -1 +1 @@\n-x\n+y')]))) as {
    requests: unknown[];
  };
  assert.equal(single.requests.length, 1);
});

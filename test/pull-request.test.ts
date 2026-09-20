import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { RECEPTOR_KEYS } from '../src/review-brain.ts';
import type { Descriptors, ReviewBrain } from '../src/review-brain.ts';
import { changedRange, flyName, parsePatch } from '../src/review-cases.ts';
import {
  PR_LIMITS,
  fetchPullRequest,
  parsePullRequestRef,
  pullRequestCase,
  pullRequestKey,
  reviewComment,
} from '../src/review-github.ts';
import type { PullRequest } from '../src/review-github.ts';
import { encodeWithJev } from '../src/review-jev.ts';
import { ReviewShow } from '../src/review-show.ts';

const testDir = await mkdtemp(join(tmpdir(), 'fly-pr-tests-'));
after(() => rm(testDir, { recursive: true, force: true }));

const features = Object.fromEntries(
  RECEPTOR_KEYS.map(key => [
    key,
    ['removesConditional', 'constantReturn', 'touchesPermissions'].includes(key) ? 0.9 : 0.05,
  ]),
) as Descriptors;
const patch =
  '@@ -1,3 +1,4 @@\n export function a() {\n-  return 1;\n+  // comment\n+  return 2;\n }\n@@ -20,2 +21,2 @@\n export function b() {\n-  return 3;\n+  return 4;\n }\n@@ -30,2 +31,2 @@\n export function c() {\n-  return 5;\n+  return 6;\n }\n\\ No newline at end of file';
const githubMock =
  (over: Partial<{ files: unknown[]; status: number }> = {}): typeof fetch =>
  async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'fly-review');
    if (over.status) return new Response('', { status: over.status });
    if (path.endsWith('/files'))
      return Response.json(
        over.files ?? [
          { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch },
          {
            filename: 'package-lock.json',
            status: 'modified',
            additions: 900,
            deletions: 3,
            patch: '@@ -1 +1 @@\n-x\n+y',
          },
          {
            filename: 'docs/new-name.md',
            previous_filename: 'docs/old-name.md',
            status: 'renamed',
            additions: 0,
            deletions: 0,
          },
          {
            filename: 'big.ts',
            status: 'added',
            additions: 5000,
            deletions: 0,
            patch: '+'.repeat(PR_LIMITS.filePatch + 500),
          },
          { filename: 'image.png', status: 'added', additions: 0, deletions: 0 },
        ],
      );
    if (path.endsWith('/reviews')) {
      assert.equal(init?.method, 'POST');
      assert.equal(JSON.parse(init?.body as string).event, 'COMMENT');
      return Response.json({ html_url: 'https://github.com/o/r/pull/12#pullrequestreview-1' });
    }
    return Response.json({
      html_url: 'https://github.com/o/r/pull/12',
      title: 'Do the thing',
      body: 'Because.',
      user: { login: 'nick' },
      base: { ref: 'main' },
      head: { ref: 'thing' },
      additions: 5902,
      deletions: 4,
      changed_files: 5,
    });
  };

test('pull request references are parsed from URLs and shorthand, and junk is refused', () => {
  for (const input of [
    'https://github.com/owner/repo/pull/123',
    'https://github.com/owner/repo/pull/123/files?x=1',
    'owner/repo#123',
    'owner/repo/pull/123',
    'repos/owner/repo/pulls/123',
    ' https://www.github.com/owner/repo.git/pull/123 ',
  ]) {
    assert.deepEqual(parsePullRequestRef(input), { owner: 'owner', repo: 'repo', number: 123 }, input);
  }
  assert.equal(pullRequestKey({ owner: 'o', repo: 'r', number: 1 }), 'o/r#1');
  for (const junk of [
    '',
    'https://gitlab.com/o/r/merge_requests/1',
    'https://github.com/o/r/issues/5',
    'o/r',
    42,
    'x'.repeat(400),
  ])
    assert.throws(() => parsePullRequestRef(junk), junk.toString());
});

test('fetching a pull request keeps every file, spends the patch budget honestly, and skips generated files', async () => {
  const pr = await fetchPullRequest({ owner: 'o', repo: 'r', number: 12 }, githubMock(), null);
  assert.equal(pr.title, 'Do the thing');
  assert.equal(pr.files.length, 5);
  assert.equal(pr.files[0].patch, patch);
  assert.equal(pr.files[1].omitted, 'generated file');
  assert.equal(pr.files[2].omitted, 'renamed, no content change');
  assert.equal(pr.files[2].previousFilename, 'docs/old-name.md');
  assert.ok(pr.files[3].patch!.length <= PR_LIMITS.filePatch + 60);
  assert.match(pr.files[3].patch!, /truncated by fly-review/);
  assert.equal(pr.files[4].omitted, 'binary or too large');
  assert.equal(pr.shownPatchChars, pr.files[0].patch!.length + pr.files[3].patch!.length);
  await assert.rejects(
    fetchPullRequest({ owner: 'o', repo: 'r', number: 12 }, githubMock({ status: 404 }), null),
    /not found.*GITHUB_TOKEN/,
  );
  await assert.rejects(
    fetchPullRequest({ owner: 'o', repo: 'r', number: 12 }, githubMock({ status: 403 }), 'tok'),
    /rate limit/,
  );
  const budget = await fetchPullRequest(
    { owner: 'o', repo: 'r', number: 12 },
    githubMock({
      files: Array.from({ length: 8 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: 'x'.repeat(PR_LIMITS.filePatch),
      })),
    }),
    null,
  );
  assert.equal(
    budget.files.filter(f => f.patch !== null).length,
    Math.floor(PR_LIMITS.totalPatch / PR_LIMITS.filePatch),
  );
  assert.ok(budget.files.some(f => f.omitted === 'over budget'));
  const review = pullRequestCase(pr);
  assert.equal(review.oracle, null);
  assert.equal(review.custom, true);
  assert.match(review.context, /merging thing into main/);
  assert.match(review.context, /Because\./);
  assert.equal(changedRange(review), '5 files · +5902 −4');
});

test('unified patches render with real line numbers, and the review comment carries the vote without code', () => {
  const lines = parsePatch(patch);
  assert.deepEqual(
    lines.map(l => l.kind),
    [
      'hunk',
      'same',
      'removed',
      'added',
      'added',
      'same',
      'hunk',
      'same',
      'removed',
      'added',
      'same',
      'hunk',
      'same',
      'removed',
      'added',
      'same',
    ],
  );
  assert.deepEqual(
    lines.map(l => l.afterLine),
    [null, 1, null, 2, 3, 4, null, 21, null, 22, 23, null, 31, null, 32, 33],
  );
  assert.deepEqual(
    lines.map(l => l.beforeLine),
    [null, 1, 2, null, null, 3, null, 20, 21, null, 22, null, 30, 31, null, 32],
  );
  assert.equal(lines[3].text, '  // comment');
  const pr: PullRequest = {
    ref: { owner: 'o', repo: 'r', number: 12 },
    url: 'u',
    title: 't',
    body: '',
    author: 'a',
    base: 'main',
    head: 'x',
    additions: 1,
    deletions: 0,
    changedFiles: 2,
    files: [
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'SECRET_PATCH' },
      { filename: 'b.ts', status: 'modified', additions: 0, deletions: 0, patch: null, omitted: 'over budget' },
    ],
    shownPatchChars: 12,
    fetchedAt: 't',
  };
  const brain = {
    seed: 7,
    feedHz: 0,
    groomHz: 0,
    escapeHz: 0,
    avoidHz: 124,
    approachHz: 20,
    noveltyHz: 0,
    activeKenyon: 203,
    rememberedSynapses: 999,
    stimuli: { 'odor:ORN_D': 120, 'odor:ORN_DA1': 90 },
  } as unknown as ReviewBrain;
  const comment = reviewComment(pr, {
    features,
    brain,
    verdict: { verdict: 'changes_requested', score: 0.86, behavior: 'still', explanation: '' },
    encoderModel: 'jev-1.13.0',
    source: 'jev',
  });
  assert.match(comment, /Changes requested/);
  assert.match(comment, new RegExp(flyName(7).replace(/[()#]/g, '\\$&')));
  assert.match(comment, /removes a conditional 90%/);
  assert.match(comment, /odor of 2 glomeruli/);
  assert.match(comment, /203 Kenyon cells active; avoidance MBONs 124 Hz against approach 20 Hz, share 0.86/);
  assert.match(comment, /999 synapses carry memory/);
  assert.match(comment, /2 changed files \(1 shown/);
  assert.doesNotMatch(comment, /SECRET_PATCH/);
});

test('Jev is shown the whole pull request, never a verdict', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only';
  try {
    const review = pullRequestCase(await fetchPullRequest({ owner: 'o', repo: 'r', number: 12 }, githubMock(), null));
    const mock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.state.pullRequest.title, 'Do the thing');
      assert.equal(body.state.files.length, 5);
      assert.equal(body.state.files[0].patch, patch);
      assert.match(body.state.files[1].patch, /omitted: generated file/);
      assert.equal('before' in body.state, false);
      assert.equal('verdict' in body.state, false);
      return Response.json({
        model: 'test-jev',
        answers: Object.fromEntries(Object.entries(features).map(([k, noul]) => [k, { type: 'noul', noul }])),
      });
    };
    assert.deepEqual((await encodeWithJev(review, mock)).features, features);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('a pull request is read hunk by hunk, saved as one bundle, refused verification, posted once, and given a second opinion without a new Jev call', async () => {
  let encodes = 0,
    unitEncodes = 0,
    sequences = 0,
    posted: string[] = [];
  // Fly #7 has learned to avoid this smell; any other fly is naive and undecided.
  const brain = (seed: number): ReviewBrain => ({
    seed,
    gain: 0.65,
    rates: [144, 140],
    neurons: 176422,
    connections: 6287749,
    projection: [[1, 1]],
    feedHz: 0,
    groomHz: 0,
    escapeHz: 0,
    avoidHz: seed === 7 ? 124 : 17,
    approachHz: seed === 7 ? 20 : 90,
    noveltyHz: 0,
    activeKenyon: 203,
    activeKenyonIds: [],
    lesson: 'none',
    depressed: 0,
    rememberedSynapses: 999,
    spikes: 50,
    wallMs: 1,
    simulatedMs: 450,
    activity: [],
    frames: Array.from({ length: 10 }, (_, i) => ({
      timeMs: 225 + i * 25,
      feedHz: 0,
      groomHz: 0,
      escapeHz: 0,
      spikes: 5,
      inputSpikes: [1, 1],
      activity: [],
    })),
  });
  const show = new ReviewShow(() => {}, {
    runsPath: testDir,
    memoryPath: join(testDir, 'memory.json'),
    encode: async () => {
      encodes++;
      return { features, model: 'test-jev', usage: null };
    },
    encodeUnit: async (_pr, unit) => {
      unitEncodes++;
      assert.match(unit.header, /^@@/);
      return { features, model: 'test-jev', usage: null };
    },
    smell: async (_odor, options = {}) => brain(options.seed ?? 7),
    smellSequence: async (odors, options = {}) => {
      sequences++;
      assert.equal(
        odors.length,
        3,
        'src/a.ts has three hunks; generated, omitted, and truncated patches are not smelled',
      );
      const hunk = (index: number, noveltyHz: number) => ({
        index,
        avoidHz: 124,
        approachHz: 20,
        noveltyHz,
        naiveNoveltyHz: 9,
        familiarity: 1 - noveltyHz / 9,
        activeKenyon: 203,
        familiarized: 16,
      });
      return {
        ...brain(options.seed ?? 7),
        stimuli: odors[1],
        sequence: { looked: 1, familiarity: 0.3, readings: 1, hunks: [hunk(0, 0), hunk(1, 3), hunk(2, 0)] },
      };
    },
    rememberLesson: async () => {},
    forget: async () => {},
    record: async () => {},
    fetchPullRequest: (ref, fetcher) => fetchPullRequest(ref, fetcher ?? githubMock(), null),
    postReview: async (_pr, body) => {
      posted.push(body);
      return { url: 'https://github.com/o/r/pull/12#pullrequestreview-1' };
    },
    githubToken: async () => 'tok',
  });
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only';
  const runs: string[] = [];
  try {
    assert.equal(await show.loadGitHub(), true);
    const preview = await show.pullRequest('o/r#12');
    assert.equal(preview.title, 'Do the thing');
    assert.equal(
      await show.pullRequest('https://github.com/o/r/pull/12'),
      preview,
      'the preview is cached, so the vote runs on exactly what was shown',
    );
    const request = { action: 'review', mode: 'jev', caseId: 'pull-request', pullRequest: 'o/r#12' } as const;
    await assert.rejects(show.act(request), /Confirm disclosure/);
    const disclosure = await show.disclosure(request);
    assert.equal(encodes, 0, 'previewing or declining disclosure never sends code to the model');
    await assert.rejects(show.act({ ...request, disclosure: '0'.repeat(64) }), /Confirm disclosure/);
    await show.act({ ...request, disclosure: disclosure.hash });
    runs.push(show.state.runDir!);
    assert.equal(encodes, 0, 'a pull request is never described as one blob');
    assert.equal(unitEncodes, 3, 'one Jev call per hunk');
    assert.equal(sequences, 1);
    assert.equal(show.state.review.pullRequest?.title, 'Do the thing');
    assert.equal(show.state.verdict?.verdict, 'changes_requested');
    assert.match(show.state.headline, /fly #7\) looked at src\/a.ts, hunk 2/);
    assert.equal(show.state.attention?.looked, 1);
    assert.equal(show.state.attention?.granularity, 'hunk');
    assert.deepEqual(
      show.state.attention?.units.map(u => [u.filename, u.lines.from, u.lines.to, u.reading.noveltyHz]),
      [
        ['src/a.ts', 0, 5, 0],
        ['src/a.ts', 6, 10, 3],
        ['src/a.ts', 11, 15, 0],
      ],
    );
    assert.ok(
      show.state.attention!.units.every(u => !('patch' in u) && !('changed' in u)),
      'patch text stays off the wire',
    );
    assert.deepEqual(
      show.state.odor,
      Object.assign({}, show.state.brain!.stimuli),
      'the odor shown is the hunk it looked at',
    );
    assert.ok(existsSync(join(show.state.runDir!, 'attention.json')));
    assert.match(await readFile(join(show.state.runDir!, 'pull-request.diff'), 'utf8'), /diff --git a\/src\/a.ts/);
    assert.equal(JSON.parse(await readFile(join(show.state.runDir!, 'pull-request.json'), 'utf8')).files.length, 5);
    await assert.rejects(show.act({ action: 'verify' }), /fly vote only/);
    await show.act({ action: 'post-review' });
    assert.equal(show.state.posted?.url, 'https://github.com/o/r/pull/12#pullrequestreview-1');
    assert.equal(posted.length, 1);
    assert.match(posted[0], /Changes requested/);
    assert.match(await readFile(join(show.state.runDir!, 'github-review.md'), 'utf8'), /fly\/review/);
    await assert.rejects(show.act({ action: 'post-review' }), /already posted/);
    await show.act({ action: 'second-opinion' });
    runs.push(show.state.runDir!);
    assert.equal(unitEncodes, 3, 'a second opinion reuses the saved per-hunk descriptions');
    assert.equal(sequences, 2, 'and reads the whole diff again with the new seed');
    assert.notEqual(show.state.brain?.seed, 7);
    assert.deepEqual(show.state.features, features);
    assert.equal(show.state.encoderModel, 'test-jev');
    assert.equal(show.state.source, 'jev');
    assert.equal(show.state.verdict?.verdict, 'no_objection');
    assert.equal(show.state.posted, null, 'a new fly has not posted anything');
    assert.equal(show.state.ledger.trials, 2);
    await assert.rejects(
      show.act({ action: 'review', mode: 'jev', caseId: 'agent-tools', seed: 0 }),
      /seed from 1 to 9999/,
    );
    await assert.rejects(
      show.act({ action: 'review', mode: 'jev', caseId: 'pull-request', pullRequest: 'nope' }),
      /does not look like/,
    );
  } finally {
    for (const run of runs) await rm(run, { recursive: true, force: true });
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

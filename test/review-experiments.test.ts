import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { atomicJSON, command, hash } from '../src/io.ts';
import { RECEPTOR_KEYS } from '../src/review-brain.ts';
import type { Features, ReviewBrain } from '../src/review-brain.ts';
import { checkSnapshot, loadMemoryLog, resetMemory, snapshotMemory } from '../src/review-memory.ts';
import { parseReviewAction } from '../src/review-action.ts';
import type { ReviewAction } from '../src/review-action.ts';
import { odorLineup, odorOverlap, readReceipt } from '../src/review-evidence.ts';
import { ReviewShow } from '../src/review-show.ts';

const features = Object.fromEntries(RECEPTOR_KEYS.map(key => [key, 0.5])) as Features;
const probe = { args: [1, 2, 50], expected: 1, rationale: 'Test the rounding boundary.' };
const reading = (over: Partial<ReviewBrain> = {}): ReviewBrain => ({
  neurons: 176422,
  connections: 6287749,
  projection: [],
  feedHz: 0,
  groomHz: 0,
  escapeHz: 0,
  avoidHz: 100,
  approachHz: 100,
  noveltyHz: 0,
  activeKenyon: 2,
  activeKenyonIds: [1, 2],
  lesson: 'none',
  depressed: 0,
  rememberedSynapses: 0,
  spikes: 20,
  wallMs: 1,
  simulatedMs: 450,
  activity: [],
  seed: 7,
  gain: 0.65,
  rates: [75],
  frames: Array.from({ length: 10 }, (_, i) => ({
    timeMs: 225 + i * 25,
    feedHz: 0,
    groomHz: 0,
    escapeHz: 0,
    spikes: 2,
    inputSpikes: [1],
    activity: [],
  })),
  ...over,
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fly-experiment-'));
  const memoryPath = join(dir, 'memory.json');
  let calls = 0;
  const show = new ReviewShow(() => {}, {
    memoryPath,
    runsPath: dir,
    record: async () => {},
    investigate: async () => ({ probe, model: 'test-only' }),
    smell: async (_odor, options = {}) => {
      calls++;
      assert.ok(options.memoryPath !== undefined, 'every experiment specifies its causal memory input');
      const edges: number[][] = options.memoryPath ? JSON.parse(await readFile(options.memoryPath, 'utf8')).edges : [];
      const taught = edges.length > 0;
      if (options.lesson && options.lesson !== 'none') await atomicJSON(options.memoryPath!, { edges: [[12, 0.4]] }, 0);
      return reading({
        seed: options.seed ?? 7,
        gain: options.gain ?? 0.65,
        avoidHz: options.gain === 0 ? 0 : 100,
        approachHz: options.gain === 0 ? 0 : taught ? 20 : 100,
        lesson: options.lesson ?? 'none',
        depressed: options.lesson && options.lesson !== 'none' ? 1 : 0,
        rememberedSynapses: taught || (options.lesson && options.lesson !== 'none') ? 1 : 0,
        wallMs: calls,
      });
    },
    poke: async (stimuli, seed, gain, memory) => {
      assert.ok(memory, 'a sensory receipt saves its input memory');
      await readFile(memory, 'utf8');
      return reading({ seed, gain, feedHz: stimuli.bitter ? 0 : 60, stimuli });
    },
  });
  return { dir, memoryPath, show, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('action parsing rejects malformed objects and every invalid optional enum before dispatch', () => {
  // @ts-expect-error Browser requests must not compile with an unsupported mode.
  const wrongMode: ReviewAction = { action: 'review', caseId: 'rounding', mode: 'mock' };
  // @ts-expect-error Browser requests must include the review's required fields.
  const missingCase: ReviewAction = { action: 'review', mode: 'manual' };
  assert.throws(() => parseReviewAction(wrongMode));
  assert.throws(() => parseReviewAction(missingCase));
  for (const value of [
    null,
    [],
    true,
    {},
    { action: 'nope' },
    { action: 'review' },
    { action: 'review', caseId: 'rounding', mode: 'fake' },
    ...[false, 0, '', null].map(vote => ({ action: 'verify', vote })),
  ])
    assert.throws(() => parseReviewAction(value));
  assert.deepEqual(parseReviewAction({ action: 'verify' }), { action: 'verify' });
  assert.deepEqual(parseReviewAction({ action: 'review', caseId: 'rounding', mode: 'manual', features }), {
    action: 'review',
    caseId: 'rounding',
    mode: 'manual',
    features,
  });
});

test('teaching stages memory, commits provenance atomically, and never changes repeat or ablation inputs', async () => {
  const f = await fixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  try {
    await f.show.act({ action: 'review', caseId: 'rounding', mode: 'manual', features });
    const initial = f.show.state.memoryInput!;
    const originalRun = f.show.state.runDir!;
    assert.equal(initial.rememberedSynapses, 0);
    await f.show.act({ action: 'verify' });
    const stored = JSON.parse(await readFile(f.memoryPath, 'utf8'));
    assert.deepEqual(stored.edges, [[12, 0.4]]);
    assert.equal(stored.lessons[0].beforeHash, initial.hash);
    assert.equal(stored.lessons[0].afterHash, f.show.state.lesson?.afterHash);
    assert.equal((await loadMemoryLog(f.memoryPath)).length, 1);
    await f.show.act({ action: 'repeat' });
    assert.equal(f.show.state.repeat?.identical, true, 'repeat after teaching still uses the original factors');
    await f.show.act({ action: 'disconnect' });
    assert.match(f.show.state.headline, /voting readout became silent/);
    assert.match(f.show.state.explanation, /10 recorded input spikes/);
    assert.deepEqual(JSON.parse(await readFile(initial.path, 'utf8')).edges, []);
    const memoryBeforeComparison = await readFile(f.memoryPath, 'utf8');
    await f.show.act({ action: 'compare-memory' });
    assert.equal(f.show.state.memoryComparison?.current.approachHz, 20);
    assert.equal(f.show.state.memoryComparison?.naive.approachHz, 100);
    assert.equal(
      await readFile(f.memoryPath, 'utf8'),
      memoryBeforeComparison,
      'a comparison neither teaches nor forgets',
    );
    await f.show.act({ action: 'recall' });
    assert.equal(f.show.state.verdict?.verdict, 'changes_requested');
    assert.equal(f.show.state.history.length, 2);
    assert.equal(f.show.state.history[0].descriptorHash, f.show.state.history[1].descriptorHash);
    assert.notEqual(f.show.state.memoryInput?.hash, initial.hash);
    await f.show.act({ action: 'reset-memory' });
    assert.equal(f.show.state.recordingHistorical, true);
    assert.equal(f.show.state.verdict?.verdict, 'changes_requested', 'reset does not fake a new measurement');
    await f.show.act({ action: 'recall' });
    assert.equal(f.show.state.verdict?.verdict, 'abstain');
    assert.equal(f.show.state.memoryInput?.hash, initial.hash);
    assert.equal(await checkSnapshot(initial), initial.path, 'forgetting leaves the original replay input intact');
    const receipt = await readReceipt(basename(originalRun), f.dir);
    assert.equal(receipt.kind, 'review');
    assert.ok('verification' in receipt && receipt.verification?.status === 'confirmed');
  } finally {
    await f.cleanup();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('a failed lesson promotion preserves live factors and a prepared recovery receipt', async () => {
  const f = await fixture();
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  // Constructor dependency injection preserves the real staging path but rejects publication.
  const show = new ReviewShow(() => {}, {
    memoryPath: f.memoryPath,
    runsPath: f.dir,
    record: async () => {},
    investigate: async () => ({ probe, model: 'test-only' }),
    smell: async (_odor, options = {}) => {
      if (options.lesson === 'punish') await atomicJSON(options.memoryPath!, { edges: [[12, 0.4]] }, 0);
      return reading({ lesson: options.lesson ?? 'none' });
    },
    rememberLesson: async () => {
      throw new Error('injected promotion failure');
    },
  });
  try {
    await atomicJSON(f.memoryPath, { edges: [], lessons: [] }, 0);
    const before = await readFile(f.memoryPath, 'utf8');
    await show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    await assert.rejects(show.act({ action: 'verify' }), /injected promotion failure/);
    assert.equal(await readFile(f.memoryPath, 'utf8'), before);
    const lessonDir = (await readdir(show.state.runDir!)).find(name => name.startsWith('lesson-'))!;
    const receipt = JSON.parse(await readFile(join(show.state.runDir!, lessonDir, 'lesson.json'), 'utf8'));
    assert.equal(receipt.status, 'prepared');
    assert.notEqual(receipt.before.hash, receipt.after.hash);
    assert.equal(show.busy, false);
  } finally {
    await f.cleanup();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('separate processes cannot both promote from the same memory baseline, and reset respects the lock', async () => {
  const f = await fixture();
  try {
    const before = await snapshotMemory(null, join(f.dir, 'before.json'));
    await atomicJSON(join(f.dir, 'after-a.json'), { edges: [[12, 0.4]] }, 0);
    await atomicJSON(join(f.dir, 'after-b.json'), { edges: [[12, 0.2]] }, 0);
    const a = await snapshotMemory(join(f.dir, 'after-a.json'), join(f.dir, 'a.json'));
    const b = await snapshotMemory(join(f.dir, 'after-b.json'), join(f.dir, 'b.json'));
    const source = `const {promoteMemory} = await import(${JSON.stringify(new URL('../src/review-memory.ts', import.meta.url).href)}); let raw=''; for await(const c of process.stdin) raw+=c; const {after,before,path,entry}=JSON.parse(raw); try { await promoteMemory(after,entry,before,path); console.log(JSON.stringify({ok:true})); } catch(error) { console.log(JSON.stringify({ok:false,error:String(error)})); }`;
    const results = await Promise.all(
      [a, b].map((after, index) =>
        command(
          process.execPath,
          ['--input-type=module', '-e', source],
          JSON.stringify({
            after,
            before,
            path: f.memoryPath,
            entry: {
              at: 'fixture',
              runDir: null,
              caseId: `fixture-${index}`,
              title: 'fixture',
              lesson: 'punish',
              reason: 'fixture',
              activeKenyon: 1,
              depressed: 1,
              rememberedSynapses: 1,
              beforeHash: before.hash,
              afterHash: after.hash,
            },
          }),
        ).then(text => JSON.parse(text)),
      ),
    );
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.match(results.find(r => !r.ok).error, /locked|Memory changed/);
    assert.equal((await loadMemoryLog(f.memoryPath)).length, 1);
    const committed = await readFile(f.memoryPath, 'utf8');
    await atomicJSON(`${f.memoryPath}.lock`, { pid: process.pid });
    await assert.rejects(resetMemory(f.memoryPath), /locked/);
    assert.equal(await readFile(f.memoryPath, 'utf8'), committed);
    await rm(`${f.memoryPath}.lock`);
    await resetMemory(f.memoryPath);
    assert.deepEqual(await loadMemoryLog(f.memoryPath), []);
  } finally {
    await f.cleanup();
  }
});

test('an isolated data directory keeps server memory, ledger, and bundle defaults together', async () => {
  const f = await fixture();
  try {
    const source = `process.env.FLY_REVIEW_DATA_DIR=${JSON.stringify(f.dir)}; const {RUNS_ROOT}=await import(${JSON.stringify(new URL('../src/io.ts', import.meta.url).href)}); const {MEMORY_PATH}=await import(${JSON.stringify(new URL('../src/review-brain.ts', import.meta.url).href)}); const {loadMemoryLog}=await import(${JSON.stringify(new URL('../src/review-memory.ts', import.meta.url).href)}); const {appendLedger}=await import(${JSON.stringify(new URL('../src/review-ledger.ts', import.meta.url).href)}); await appendLedger({type:'vote',at:'fixture',runDir:null,caseId:'isolated-fixture',custom:true,feedHz:0,groomHz:0,escapeHz:0,verdict:'abstain'}); console.log(JSON.stringify({runs:RUNS_ROOT,memory:MEMORY_PATH,lessons:await loadMemoryLog()}));`;
    const actual = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', source]));
    assert.equal(actual.runs, f.dir);
    assert.equal(actual.memory, f.memoryPath);
    assert.deepEqual(actual.lessons, []);
    assert.equal(JSON.parse(await readFile(join(f.dir, 'ledger.jsonl'), 'utf8')).caseId, 'isolated-fixture');
  } finally {
    await f.cleanup();
  }
});

test('the lock remains owned during final persistence and releases after a persistence failure', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const writing = new Promise<void>(resolve => {
    entered = resolve;
  });
  const show = new ReviewShow(() => {}, {
    memoryPath: f.memoryPath,
    runsPath: f.dir,
    record: async () => {},
    smell: async () => reading(),
    persist: async () => {
      entered();
      await pending;
      throw new Error('injected write failure');
    },
  });
  const first = show.act({ action: 'review', caseId: 'rounding', mode: 'manual', features });
  const result = assert.rejects(first, /injected write failure/);
  try {
    await writing;
    assert.equal(show.busy, true);
    await assert.rejects(show.act({ action: 'poke', stimuli: { sugar: 150 } }), /Wait for the current/);
  } finally {
    release();
    await result;
    await f.cleanup();
  }
  assert.equal(show.busy, false);
});

test('sugar and bitter use the same seed, intensity, and memory, and have receipts without a review', async () => {
  const f = await fixture();
  try {
    await f.show.act({ action: 'poke', stimuli: { sugar: 125 }, seed: 17 });
    const sugar = f.show.state.poke!;
    await f.show.act({ action: 'add-bitter' });
    const mixed = f.show.state.poke!;
    assert.deepEqual(mixed.stimuli, { sugar: 125, bitter: 150 });
    assert.equal(mixed.brain.seed, sugar.brain.seed);
    assert.equal(mixed.memoryInput.hash, sugar.memoryInput.hash);
    assert.equal(f.show.state.pokePair?.sugar.brain.feedHz, 60);
    assert.equal(f.show.state.pokePair?.mixed.brain.feedHz, 0);
    assert.equal(f.show.state.runDir, null);
    assert.equal(f.show.state.verdict, null);
    assert.equal(f.show.state.memory.lessons.length, 0);
    assert.equal((await readReceipt(mixed.receiptId, f.dir)).kind, 'sensory');
    await assert.rejects(f.show.act({ action: 'add-bitter' }), /sugar-only/);
  } finally {
    await f.cleanup();
  }
});

test('ablation claims follow MBONs rather than motor activity, including silent baselines', async () => {
  const f = await fixture();
  try {
    for (const [original, ablated, silenced] of [
      [reading({ feedHz: 60 }), reading({ feedHz: 0 }), false],
      [reading(), reading({ avoidHz: 0, approachHz: 0 }), true],
      [reading({ avoidHz: 0, approachHz: 0 }), reading({ avoidHz: 0, approachHz: 0 }), false],
    ] as const) {
      const show = new ReviewShow(() => {}, {
        memoryPath: f.memoryPath,
        runsPath: f.dir,
        record: async () => {},
        smell: async (_odor, options = {}) => (options.gain === 0 ? ablated : original),
      });
      await show.act({ action: 'review', caseId: 'rounding', mode: 'manual', features });
      await show.act({ action: 'disconnect' });
      assert.equal(show.state.headline.includes('became silent'), silenced);
      assert.doesNotMatch(show.state.headline, /inputs fired|verdict disappeared/i);
      assert.deepEqual(show.state.brain, original);
    }
  } finally {
    await f.cleanup();
  }
});

test('code disclosure is bound to the exact pasted payload and never calls a model while preparing', async () => {
  const f = await fixture();
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only';
  let encodes = 0;
  const show = new ReviewShow(() => {}, {
    memoryPath: f.memoryPath,
    runsPath: f.dir,
    record: async () => {},
    smell: async () => reading(),
    encode: async review => {
      encodes++;
      assert.equal(review.after, 'export function f() { return 3; }');
      return { features, model: 'test-only', usage: null };
    },
  });
  try {
    const request = {
      action: 'review',
      mode: 'jev',
      caseId: 'custom',
      custom: {
        filename: 'change.ts',
        before: 'export function f() { return 1; }',
        after: 'export function f() { return 2; }',
        context: '',
      },
    } as const;
    const first = await show.disclosure(request);
    assert.equal(encodes, 0);
    const changed = { ...request, custom: { ...request.custom, after: 'export function f() { return 3; }' } };
    await assert.rejects(show.act({ ...changed, disclosure: first.hash }), /exact code payload/);
    assert.equal(encodes, 0);
    const second = await show.disclosure(changed);
    assert.notEqual(first.hash, second.hash);
    await show.act({ ...changed, disclosure: second.hash });
    assert.equal(encodes, 1);
    const saved = await readFile(join(show.state.runDir!, 'disclosure.json'), 'utf8');
    assert.match(saved, /TypeSafe/);
    assert.doesNotMatch(saved, /test-only/);
  } finally {
    await f.cleanup();
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('saved snapshots fail closed on tampering and receipts reject traversal and symlinks', async () => {
  const f = await fixture();
  try {
    const snapshot = await snapshotMemory(null, join(f.dir, 'snapshot.json'));
    assert.equal(snapshot.hash, hash('{"edges":[]}'));
    await atomicJSON(snapshot.path, { edges: [[1, 0.1]] });
    await assert.rejects(checkSnapshot(snapshot), /hash does not match/);
    for (const id of ['../memory', '/etc/passwd', 'review-abcdef/../../x', 'review-%2e%2e%2f'])
      await assert.rejects(readReceipt(id, f.dir), /Invalid evidence/);
    await f.show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    await symlink(f.show.state.runDir!, join(f.dir, 'review-abcdef'));
    await assert.rejects(readReceipt('review-abcdef', f.dir), /Symlinked/);
  } finally {
    await f.cleanup();
  }
});

test('odor lineup computes set overlap and marks missing or incompatible receipts unavailable', async () => {
  assert.deepEqual(odorOverlap([1, 2], [2, 3]), { shared: 1, total: 3, overlap: 1 / 3 });
  assert.equal(odorOverlap([1, 2, 2], [1, 2]).overlap, 1);
  assert.equal(odorOverlap([1], [2]).overlap, 0);
  const f = await fixture();
  try {
    await f.show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    const lesson = {
      at: 'fixture',
      runDir: f.show.state.runDir,
      caseId: 'rounding',
      title: 'fixture',
      lesson: 'punish' as const,
      reason: 'fixture',
      activeKenyon: 2,
      depressed: 1,
      rememberedSynapses: 1,
    };
    f.show.state.memory.lessons = [lesson, { ...lesson, runDir: join(f.dir, 'review-absent') }];
    const result = await odorLineup(f.show.state, f.dir);
    assert.equal(result.matches[0].overlap, 1);
    assert.equal(result.unavailable, 1);
    const legacy = { ...f.show.state, odorCodeVersion: 'legacy' };
    await atomicJSON(join(f.show.state.runDir!, 'review.json'), legacy);
    assert.equal((await odorLineup(f.show.state, f.dir)).unavailable, 2);
  } finally {
    await f.cleanup();
  }
});

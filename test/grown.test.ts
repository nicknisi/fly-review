import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewCase } from '../src/review-cases.ts';
import { sweepFor } from '../src/review-grow.ts';
import { validateGrownCase } from '../src/review-grown.ts';
import { deterministicInputs } from '../src/review-oracles.ts';
import { executeProbe, labelByExecution } from '../src/review-verify.ts';

const scenario = {
  group: 'Test',
  filename: 'clamp.ts',
  functionName: 'clampPercent',
  contract: 'clampPercent(value) returns value limited to 0 through 100.',
  context: 'Called with user input.',
  parameters: [{ name: 'value', type: 'integer' as const, min: -10, max: 110 }],
  oracle: 'reference' as const,
  format: 'number' as const,
  reference: `export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}`,
  before: `export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}`,
  sweep: sweepFor([{ name: 'value', type: 'integer', min: -10, max: 110 }]),
  smell: 'clamping',
  grown: { model: 'test', at: 'now', scenario: 'clamp' },
};
const regression: ReviewCase = {
  ...scenario,
  id: 'clamp-drop-upper',
  title: 'Simplify clamp',
  after: `export function clampPercent(value: number): number {
  return Math.max(0, value);
}`,
};
const control: ReviewCase = {
  ...scenario,
  id: 'clamp-rename',
  title: 'Name the bounds',
  control: true,
  after: `export function clampPercent(value: number): number {
  const lower = 0, upper = 100;
  return Math.min(upper, Math.max(lower, value));
}`,
};

test('sweepFor covers both ends of every domain and stays within the runner limit', () => {
  const sweep = sweepFor([
    { name: 'a', type: 'integer', min: 0, max: 1000 },
    { name: 'b', type: 'integer', min: -5, max: 5 },
    { name: 'c', type: 'enum', values: ['x', 'y', 'z'] },
  ]);
  assert.ok(sweep.length <= 50 && sweep.length > 10);
  assert.ok(sweep.some(r => r[0] === 0) && sweep.some(r => r[0] === 1000));
  assert.ok(sweep.some(r => r[1] === -5) && sweep.some(r => r[1] === 5));
  const witnessed = sweepFor([{ name: 'a', type: 'integer', min: 0, max: 10 }], [[7]]);
  assert.deepEqual(witnessed[0], [7]);
  assert.equal(new Set(witnessed.map(r => JSON.stringify(r))).size, witnessed.length);
});

test('a grown case is labeled by executing its reference, not by its claim', async () => {
  assert.equal((await labelByExecution(regression)).status, 'confirmed');
  assert.equal((await labelByExecution(control)).status, 'unsubstantiated');
  const lying = { ...control, id: 'clamp-lying', after: regression.after };
  assert.equal((await labelByExecution(lying)).status, 'confirmed');
  const brokenReference = { ...control, id: 'clamp-broken-ref', reference: regression.after };
  assert.equal((await labelByExecution(brokenReference)).status, 'inconclusive');
  assert.deepEqual(deterministicInputs(regression), regression.sweep);
});

test('executeProbe judges a grown case with the reference and reports the counterexample', async () => {
  const receipt = await executeProbe(regression, { args: [105], expected: 100, rationale: 'over the cap' }, 'test');
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.probeFoundRegression, true);
  assert.equal(receipt.modelExpectedCorrect, true);
  assert.deepEqual(receipt.counterexample?.args, [105]);
});

test('validateGrownCase rejects cases that could be mistaken for bundled examples or lack proof material', () => {
  assert.doesNotThrow(() => validateGrownCase(control));
  assert.throws(() => validateGrownCase({ ...control, id: 'rounding' }), /collides/);
  assert.throws(() => validateGrownCase({ ...control, sweep: [] }), /sweep/);
  assert.throws(() => validateGrownCase({ ...control, oracle: 'checkout' }), /reference/);
});

test('an installed trained memory is read fresh by the next review, its Kenyon ids stay server-side, and nearest lessons are ranked by overlap', async () => {
  const { mkdtemp, rm, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { atomicJSON } = await import('../src/io.ts');
  const { installMemory, loadMemoryLog } = await import('../src/review-memory.ts');
  const { ReviewShow } = await import('../src/review-show.ts');
  const { RECEPTOR_KEYS } = await import('../src/review-brain.ts');
  const dir = await mkdtemp(join(tmpdir(), 'fly-trained-'));
  try {
    const memoryPath = join(dir, 'memory.json');
    const trained = join(dir, 'trained.json');
    const lesson = (caseId: string, lesson: 'punish' | 'reward', kenyonIds: number[]) => ({
      at: 'now',
      runDir: null,
      caseId,
      title: caseId,
      lesson,
      reason: 'test',
      activeKenyon: kenyonIds.length,
      depressed: 1,
      rememberedSynapses: 2,
      source: 'training' as const,
      kenyonIds,
    });
    await atomicJSON(trained, {
      edges: [
        [5, 0.4],
        [9, 0.7],
      ],
      lessons: [
        lesson('far', 'reward', [100, 101, 102]),
        lesson('near', 'punish', [1, 2, 3, 4]),
        lesson('none', 'reward', [50]),
      ],
    });
    const installed = await installMemory(trained, memoryPath);
    assert.deepEqual(installed, { edges: 2, lessons: 3 });
    assert.equal(JSON.parse(await read(memoryPath, 'utf8')).edges.length, 2);
    assert.equal((await loadMemoryLog(memoryPath)).length, 3);

    const features = Object.fromEntries(RECEPTOR_KEYS.map(key => [key, 0.5]));
    const show = new ReviewShow(() => {}, {
      memoryPath,
      runsPath: dir,
      record: async () => {},
      smell: async (_odor, options = {}) =>
        ({
          neurons: 176422,
          connections: 6287749,
          projection: [],
          feedHz: 0,
          groomHz: 0,
          escapeHz: 0,
          avoidHz: 120,
          approachHz: 30,
          activeKenyon: 3,
          activeKenyonIds: [1, 2, 3],
          lesson: 'none',
          depressed: 0,
          rememberedSynapses: 2,
          spikes: 1,
          wallMs: 1,
          simulatedMs: 450,
          activity: [],
          seed: options.seed ?? 7,
          gain: 0.65,
          rates: [],
          frames: [],
        }) as never,
    });
    // The server started before the install: its lessons are empty until the next review reads the file.
    assert.equal(show.state.memory.lessons.length, 0);
    await show.act({ action: 'review', mode: 'manual', caseId: 'rounding', features });
    assert.equal(show.state.memory.lessons.length, 3);
    assert.ok(
      show.state.memory.lessons.every(l => !('kenyonIds' in l)),
      'Kenyon ids never reach the client',
    );
    assert.equal(show.state.nearest?.[0].caseId, 'near');
    assert.equal(show.state.nearest?.[0].shared, 3);
    assert.ok(Math.abs(show.state.nearest![0].overlap - 3 / 4) < 1e-9);
    assert.deepEqual(
      show.state.nearest?.map(n => n.shared),
      [3, 0, 0],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

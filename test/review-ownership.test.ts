import assert from 'node:assert/strict';
import test from 'node:test';
import { RECEPTOR_KEYS } from '../src/review-brain.ts';
import type { Features, ReviewBrain } from '../src/review-brain.ts';
import { ReviewShow } from '../src/review-show.ts';
import type { ReviewAction } from '../src/review-show.ts';

const features = Object.fromEntries(RECEPTOR_KEYS.map(key => [key, 0.1])) as Features;

test('the operation lock covers PR resolution before any simulation can start', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  let pokes = 0;
  const show = new ReviewShow(() => {}, {
    fetchPullRequest: async () => {
      await pending;
      throw new Error('fixture fetch stopped');
    },
    poke: async () => {
      pokes++;
      throw new Error('unexpected poke');
    },
  });
  const first = show.act({ action: 'review', mode: 'manual', caseId: 'pull-request', pullRequest: 'o/r#1', features });
  const firstResult = assert.rejects(first, /fixture fetch stopped/);
  try {
    await assert.rejects(show.act({ action: 'poke', stimuli: { sugar: 150 } }), /Wait for the current/);
    assert.equal(pokes, 0);
  } finally {
    release();
    await firstResult;
  }
  assert.equal(show.busy, false);
  assert.equal(show.state.phase, 'idle', 'rejected input must preserve the current run');
});

test('every supplied prediction is validated, including falsy values', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only';
  let investigations = 0;
  const show = new ReviewShow(() => {}, {
    investigate: async () => {
      investigations++;
      throw new Error('unexpected investigation');
    },
  });
  show.state.brain = { seed: 7 } as ReviewBrain;
  show.state.features = features;
  try {
    for (const vote of [false, 0, '', null, [], {}]) {
      await assert.rejects(show.act({ action: 'verify', vote } as ReviewAction), /Invalid prediction/);
    }
    assert.equal(investigations, 0);
    assert.equal(show.state.phase, 'idle');
    assert.equal(show.busy, false);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { geometryTransform, normalizePoint } from '../src/brain-geometry.ts';

test('3D visualization preserves measured depth instead of inventing it from a flat projection', () => {
  const transform = geometryTransform([
    [0, 0, 0],
    [10, 10, 10],
  ]);
  assert.deepEqual(transform.center, [5, 5, 5]);
  assert.equal(transform.scale, 0.2);
  const front = normalizePoint([2, 0, 3], transform);
  const back = normalizePoint([2, 10, 3], transform);
  assert.equal(front[0], back[0]);
  assert.equal(front[1], back[1]);
  assert.equal(front[2], -1);
  assert.equal(back[2], 1);
});

test('geometry uses one scale for all axes and handles a degenerate sample without division by zero', () => {
  const transform = geometryTransform([
    [0, 0, 0],
    [100, 10, 20],
  ]);
  assert.equal(transform.scale, 0.02);
  const a = normalizePoint([0, 0, 0], transform),
    b = normalizePoint([10, 10, 10], transform);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(Math.abs(b[i] - a[i]) - 0.2) < 1e-12);
  const single = geometryTransform([[3, 4, 5]]);
  assert.ok(normalizePoint([3, 4, 5], single).every(n => Number.isFinite(n) && n === 0));
  assert.throws(() => geometryTransform([]));
  assert.throws(() => geometryTransform([[0, NaN, 1]]));
});

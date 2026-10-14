import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicJSON, command } from '../src/io.ts';

test('review evidence is atomically replaced and a failed serialization preserves the prior file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fly-review-evidence-'));
  try {
    const path = join(dir, 'review.json');
    await atomicJSON(path, { verdict: 'abstain' });
    await atomicJSON(path, { verdict: 'changes_requested' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { verdict: 'changes_requested' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(atomicJSON(path, circular), /circular/i);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { verdict: 'changes_requested' });
    assert.deepEqual(await readdir(dir), ['review.json']);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subprocess boundary carries input and fails on errors or deadline expiry', async () => {
  const output = await command(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'measured data');
  assert.equal(output, 'measured data');
  await assert.rejects(
    command(process.execPath, ['-e', 'console.error("simulation failed"); process.exit(2)']),
    /simulation failed/,
  );
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], '', 100));
  // The JVM's shape under load: it outlives the deadline, shrugs off SIGTERM, swallows the broken pipe, and exits 0.
  // That must be a timeout, never a success carrying truncated output.
  const stubborn = `process.on('SIGTERM', () => {}); process.stdout.on('error', () => {});
    setTimeout(() => process.stdout.write('[' + '1,'.repeat(200000) + '1]'), 300);`;
  await assert.rejects(command(process.execPath, ['-e', stubborn], '', 100), /timed out/);
});

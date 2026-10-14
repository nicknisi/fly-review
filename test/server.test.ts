import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from '../src/io.ts';
import { RECEPTOR_KEYS } from '../src/review-brain.ts';

/** Start the real server on a free port with extra environment; resolves once it is listening. */
async function startServer(extra: Record<string, string> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fly-server-tests-'));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [join(ROOT, 'src/server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TYPESAFE_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      FLY_REVIEW_DATA_DIR: dataDir,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('fly-review:')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${stderr}`));
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

test('server exposes only fly-review and rejects cross-origin actions', { timeout: 15000 }, async () => {
  const { base, stop } = await startServer();
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Ask the fly/);
    assert.doesNotMatch(html, /Previous arcade/);
    const deckPage = await fetch(`${base}/presentation`);
    assert.equal(deckPage.status, 200);
    assert.match(await deckPage.text(), /Are You Smarter Than A Fruit Fly/);
    const deckData = await fetch(`${base}/deck.json`);
    assert.equal(deckData.status, 200);
    const deck = (await deckData.json()) as { numbers: { heldOut: number }; recordings: Record<string, unknown> };
    assert.equal(deck.numbers.heldOut, 301);
    assert.ok(deck.recordings.objects && deck.recordings.scrambled, 'the deck carries real recordings');
    const current = await fetch(`${base}/api/review/state`);
    assert.equal(current.status, 200);
    const state = (await current.json()) as { hasJev: boolean; hasInvestigator: boolean; review: { id: string } };
    assert.equal(state.review.id, 'agent-tools');
    assert.equal(state.hasJev, false);
    assert.equal(state.hasInvestigator, false);
    for (const path of ['/arcade', '/events', '/api/state', '/app.js', '/style.css', '/src/arena.js']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
    const oldAction = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: '{"action":"start"}',
    });
    assert.equal(oldAction.status, 404);
    await oldAction.text();
    const rejected = await fetch(`${base}/api/review/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
      body: '{"action":"repeat"}',
    });
    assert.equal(rejected.status, 403);
    await rejected.text();
    const missingKey = await fetch(`${base}/api/review/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: '{"action":"review","mode":"jev","caseId":"agent-tools"}',
    });
    assert.equal(missingKey.status, 400);
    assert.match(await missingKey.text(), /TYPESAFE_API_KEY/);
    const post = (body: unknown) =>
      fetch(`${base}/api/review/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify(body),
      });
    const features = {
      weakensGuard: 0.1,
      timingHazard: 0.1,
      exposesData: 0.1,
      changesResults: 0.1,
      strengthens: 0.5,
      preservesBehavior: 0.5,
    };
    const identical = await post({
      action: 'review',
      mode: 'manual',
      caseId: 'custom',
      features,
      custom: { filename: 'x.ts', before: 'a', after: 'a', context: '' },
    });
    assert.equal(identical.status, 400);
    assert.match(await identical.text(), /identical/);
    const traversal = await post({
      action: 'review',
      mode: 'manual',
      caseId: 'custom',
      features,
      custom: { filename: '../../etc/passwd.ts', before: 'a', after: 'b', context: '' },
    });
    assert.equal(traversal.status, 400);
    assert.match(await traversal.text(), /Filename/);
    const oversized = await post({
      action: 'review',
      mode: 'manual',
      caseId: 'custom',
      features,
      custom: { filename: 'x.ts', before: 'a'.repeat(40_000), after: 'b'.repeat(40_000), context: '' },
    });
    assert.equal(oversized.status, 413);
    await oversized.text();
    const tooLong = await post({
      action: 'review',
      mode: 'manual',
      caseId: 'custom',
      features,
      custom: { filename: 'x.ts', before: 'a'.repeat(13_000), after: 'b', context: '' },
    });
    assert.equal(tooLong.status, 400);
    assert.match(await tooLong.text(), /12,000/);
    assert.match(html, /Paste your own change|custom-form/);
  } finally {
    await stop();
  }
});

test(
  'in public mode every visitor gets their own fly, and nothing can be taught, wiped, or posted',
  { timeout: 15000 },
  async () => {
    const { base, stop } = await startServer({ FLY_REVIEW_PUBLIC: '1', PUBLIC_ORIGIN: 'https://fruitfly.review' });
    try {
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const cookie = async (path: string) => {
        const page = await fetch(base + path);
        await page.text();
        return /fly=([a-f0-9]{32})/.exec(page.headers.get('set-cookie') ?? '')?.[1];
      };
      const [first, second] = [await cookie('/'), await cookie('/presentation')];
      assert.ok(first && second && first !== second, 'each page load without a cookie starts a new visitor');
      const state = (await (
        await fetch(`${base}/api/review/state`, { headers: { Cookie: `fly=${first}` } })
      ).json()) as {
        public: boolean;
        hasInvestigator: boolean;
      };
      assert.equal(state.public, true);
      assert.equal(state.hasInvestigator, false);
      for (const action of ['reset-memory', 'post-review', 'verify']) {
        const refused = await fetch(`${base}/api/review/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://fruitfly.review', Cookie: `fly=${first}` },
          body: JSON.stringify({ action }),
        });
        assert.equal(refused.status, 403, action);
        assert.match(await refused.text(), /Not on the public site/);
      }
      const foreign = await fetch(`${base}/api/review/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', Cookie: `fly=${first}` },
        body: '{"action":"repeat"}',
      });
      assert.equal(foreign.status, 403);
      await foreign.text();
    } finally {
      await stop();
    }
  },
);

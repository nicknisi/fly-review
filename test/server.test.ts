import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from '../src/io.ts';

test('server exposes only fly-review and rejects cross-origin actions', { timeout: 15000 }, async () => {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [join(ROOT, 'src/server.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('fly-review:')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Ask the fly/);
    assert.doesNotMatch(html, /Previous arcade/);
    const current = await fetch(`${base}/api/review/state`);
    assert.equal(current.status, 200);
    const state = await current.json() as { hasJev: boolean; hasInvestigator: boolean; review: { id: string } };
    assert.equal(state.review.id, 'agent-tools');
    assert.equal(state.hasJev, false);
    assert.equal(state.hasInvestigator, false);
    for (const path of ['/arcade', '/events', '/api/state', '/app.js', '/style.css', '/src/arena.js']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, path);
      await response.text();
    }
    const oldAction = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"action":"start"}' });
    assert.equal(oldAction.status, 404); await oldAction.text();
    const rejected = await fetch(`${base}/api/review/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' }, body: '{"action":"repeat"}' });
    assert.equal(rejected.status, 403); await rejected.text();
    const missingKey = await fetch(`${base}/api/review/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"action":"review","mode":"jev","caseId":"agent-tools"}' });
    assert.equal(missingKey.status, 400);
    assert.match(await missingKey.text(), /TYPESAFE_API_KEY/);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});

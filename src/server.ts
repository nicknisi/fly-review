import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './io.ts';
import { pokeBrain, smellBrain, smellSequence } from './review-brain.ts';
import { fetchPullRequest, pullRequestCase, pullRequestKey } from './review-github.ts';
import type { PullRequest, PullRequestRef } from './review-github.ts';
import { encodeUnitWithJev, encodeWithJev } from './review-jev.ts';
import { ReviewShow } from './review-show.ts';
import { parseReviewAction } from './review-action.ts';
import type { ReviewAction } from './review-action.ts';
import { odorLineup, readReceipt } from './review-evidence.ts';

const port = Number(process.env.PORT ?? 4488);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
/**
 * FLY_REVIEW_PUBLIC=1 is fruitfly.review: the server sits in a container behind a Cloudflare Worker, every visitor gets
 * their own fly (a cookie session) sharing one simulator, nothing can be posted, taught, or forgotten, and a daily cap
 * limits the Jev calls billed to the deployment's key. Without it, this is the local lab, one shared fly, as before.
 */
const PUBLIC = process.env.FLY_REVIEW_PUBLIC === '1';
const origins = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  ...(process.env.PUBLIC_ORIGIN ? [process.env.PUBLIC_ORIGIN] : []),
]);
const BLOCKED_IN_PUBLIC = new Set<ReviewAction['action']>(['verify', 'post-review', 'reset-memory']);

/** In public, one simulation at a time, whoever's fly asks: a queue in front of the JVM. */
let simulator: Promise<unknown> = Promise.resolve();
const oneAtATime =
  <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> => {
    const next = simulator.then(() => run(...args));
    simulator = next.catch(() => {});
    return next;
  };
/** In public, at most FLY_REVIEW_JEV_DAILY Jev calls a day (one per hunk), across every visitor. */
const jevDaily = Number(process.env.FLY_REVIEW_JEV_DAILY ?? 400);
const jevSpent = { day: '', calls: 0 };
const budgeted =
  <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> => {
    const day = new Date().toISOString().slice(0, 10);
    if (jevSpent.day !== day) Object.assign(jevSpent, { day, calls: 0 });
    if (++jevSpent.calls > jevDaily)
      return Promise.reject(new Error('The fly has read all the code it can today. Try again tomorrow.'));
    return run(...args);
  };
/** In public, per visitor (the Worker's x-fly-client: their IP) per hour: reviews, and everything else that runs. */
const LIMITS = { review: Number(process.env.FLY_REVIEW_REVIEWS_HOURLY ?? 10), other: 120 };
const spent = new Map<string, { hour: number; review: number; other: number }>();
function allow(request: IncomingMessage, kind: 'review' | 'other') {
  if (!PUBLIC) return true;
  const client = String(request.headers['x-fly-client'] ?? 'anonymous'),
    hour = Math.floor(Date.now() / 3_600_000);
  let use = spent.get(client);
  if (!use || use.hour !== hour) spent.set(client, (use = { hour, review: 0, other: 0 }));
  return ++use[kind] <= LIMITS[kind];
}

/** In public, one fetch of a pull request serves every visitor for five minutes (GitHub rate limits are per IP). */
const pullRequests = new Map<string, { at: number; pr: Promise<PullRequest> }>();
function sharedPullRequest(ref: PullRequestRef) {
  const key = pullRequestKey(ref),
    hit = pullRequests.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pr;
  const pr = fetchPullRequest(ref);
  pullRequests.set(key, { at: Date.now(), pr });
  pr.catch(() => pullRequests.delete(key));
  return pr;
}

type Session = { show: ReviewShow; clients: Set<ServerResponse>; seen: number };
async function openSession(): Promise<Session> {
  const clients = new Set<ServerResponse>();
  const show = new ReviewShow(
    state => {
      const message = `data: ${JSON.stringify(state)}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 2_000_000) {
          client.end();
          clients.delete(client);
        } else client.write(message);
      }
    },
    PUBLIC
      ? {
          smell: oneAtATime(smellBrain),
          smellSequence: oneAtATime(smellSequence),
          poke: oneAtATime(pokeBrain),
          encode: budgeted(encodeWithJev),
          encodeUnit: budgeted(encodeUnitWithJev),
          fetchPullRequest: sharedPullRequest,
          // Never the gh CLI's token: only a token deliberately given to the deployment (public repositories only).
          githubToken: async () => process.env.GITHUB_TOKEN || null,
        }
      : {},
  );
  await show.loadLedger();
  await show.loadMemory();
  await show.loadGitHub();
  return { show, clients, seen: Date.now() };
}
const local = PUBLIC ? null : await openSession();
const sessions = new Map<string, Promise<Session>>();
const cookieId = (request: IncomingMessage) => /(?:^|;\s*)fly=([a-f0-9]{32})/.exec(request.headers.cookie ?? '')?.[1];
/** The visitor's session id from their cookie, issuing one on this response if they have none. */
function visitor(request: IncomingMessage, response: ServerResponse) {
  let id = cookieId(request);
  if (!id) {
    id = randomBytes(16).toString('hex');
    response.setHeader('Set-Cookie', `fly=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
  }
  return id;
}
async function sessionFor(request: IncomingMessage, response: ServerResponse): Promise<Session> {
  if (local) return local;
  const id = visitor(request, response);
  let session = sessions.get(id);
  if (!session) sessions.set(id, (session = openSession()));
  const opened = await session;
  opened.seen = Date.now();
  return opened;
}
// Forget visitors idle for half an hour: no open page, nothing running.
if (PUBLIC)
  setInterval(async () => {
    for (const [id, pending] of sessions) {
      const session = await pending;
      if (!session.clients.size && !session.show.busy && Date.now() - session.seen > 30 * 60_000) sessions.delete(id);
    }
    for (const [key, hit] of pullRequests) if (Date.now() - hit.at > 5 * 60_000) pullRequests.delete(key);
  }, 60_000).unref();
const files: Record<string, [string, string]> = {
  '/': ['web/review.html', 'text/html; charset=utf-8'],
  '/review.css': ['web/review.css', 'text/css; charset=utf-8'],
  '/review.js': ['.runtime/web/web/review.js', 'text/javascript; charset=utf-8'],
  '/brain-view.js': ['.runtime/web/web/brain-view.js', 'text/javascript; charset=utf-8'],
  '/fly.js': ['.runtime/web/web/fly.js', 'text/javascript; charset=utf-8'],
  '/fly-model.js': ['.runtime/web/web/fly-model.js', 'text/javascript; charset=utf-8'],
  '/walkthrough.js': ['.runtime/web/web/walkthrough.js', 'text/javascript; charset=utf-8'],
  '/walkthrough.css': ['web/walkthrough.css', 'text/css; charset=utf-8'],
  '/review-disclosure.js': ['.runtime/web/web/review-disclosure.js', 'text/javascript; charset=utf-8'],
  '/review-experiments.js': ['.runtime/web/web/review-experiments.js', 'text/javascript; charset=utf-8'],
  '/review-experiments.css': ['web/review-experiments.css', 'text/css; charset=utf-8'],
  '/src/brain-geometry.js': ['.runtime/web/src/brain-geometry.js', 'text/javascript; charset=utf-8'],
  '/anatomy.json': ['.runtime/review-anatomy.json', 'application/json'],
  '/src/review-cases.js': ['.runtime/web/src/review-cases.js', 'text/javascript; charset=utf-8'],
  '/src/review-pokes.js': ['.runtime/web/src/review-pokes.js', 'text/javascript; charset=utf-8'],
  '/src/review-odor.js': ['.runtime/web/src/review-odor.js', 'text/javascript; charset=utf-8'],
  '/src/review-verdict.js': ['.runtime/web/src/review-verdict.js', 'text/javascript; charset=utf-8'],
  '/src/review-hunks.js': ['.runtime/web/src/review-hunks.js', 'text/javascript; charset=utf-8'],
  // The talk deck: the same brain and fly, with numbers and recordings from data/deck.json (npm run deck).
  '/presentation': ['web/presentation.html', 'text/html; charset=utf-8'],
  '/presentation.css': ['web/presentation.css', 'text/css; charset=utf-8'],
  '/presentation.js': ['.runtime/web/web/presentation.js', 'text/javascript; charset=utf-8'],
  '/doom.js': ['.runtime/web/web/doom.js', 'text/javascript; charset=utf-8'],
  '/deck.json': ['data/deck.json', 'application/json'],
  '/assets/workos-logo-white.svg': ['web/assets/workos-logo-white.svg', 'image/svg+xml'],
  '/assets/nick-nisi.webp': ['web/assets/nick-nisi.webp', 'image/webp'],
  '/assets/fruitfly-qr.svg': ['web/assets/fruitfly-qr.svg', 'image/svg+xml'],
  '/assets/wanted-nick.webp': ['web/assets/wanted-nick.webp', 'image/webp'],
};
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
  const path = request.url?.split('?')[0] ?? '/';
  if (path === '/health') {
    response.writeHead(200).end('ok');
    return;
  }
  // Locally, loopback only. In public the container is reachable only through the Worker, so the Host is the Worker's.
  if (!PUBLIC && !origins.has(`http://${request.headers.host}`)) {
    response.writeHead(403).end('Localhost only');
    return;
  }
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method === 'GET' && path === '/review-events') {
      const { show, clients } = await sessionFor(request, response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(show.state)}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        clients.delete(response);
        clearInterval(heartbeat);
      });
      return;
    }
    if (path.startsWith('/api/') && !allow(request, 'other')) {
      json(429, { error: 'Slow down: too many requests from here this hour.' });
      return;
    }
    const review = path.startsWith('/api/') ? (await sessionFor(request, response)).show : null;
    if (request.method === 'GET' && path === '/api/review/state') {
      json(200, review!.state);
      return;
    }
    if (request.method === 'GET' && path === '/api/review/lineup') {
      json(200, await odorLineup(review!.state));
      return;
    }
    if (request.method === 'GET' && path === '/api/review/receipt') {
      const id = new URL(request.url ?? '/', `http://${request.headers.host}`).searchParams.get('id');
      json(200, await readReceipt(id));
      return;
    }
    if (request.method === 'GET' && path === '/api/pull-request') {
      // Preview only: the page shows exactly what the encoder will be shown, before anything is spent.
      const reference = new URL(request.url ?? '/', `http://${request.headers.host}`).searchParams.get('ref');
      json(200, pullRequestCase(await review!.pullRequest(reference)));
      return;
    }
    if (request.method === 'POST' && (path === '/api/review/action' || path === '/api/review/disclosure')) {
      if (!origins.has(request.headers.origin ?? '') || request.headers['content-type'] !== 'application/json') {
        json(403, { error: 'Same-origin JSON requests only' });
        return;
      }
      if (review!.busy) {
        json(409, { error: 'The current review operation is still running.' });
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 65_536) {
          json(413, { error: 'Request too large' });
          return;
        }
      }
      const input = parseReviewAction(JSON.parse(body));
      if (path === '/api/review/disclosure') {
        json(200, await review!.disclosure(input));
        return;
      }
      if (PUBLIC && BLOCKED_IN_PUBLIC.has(input.action)) {
        json(403, {
          error: 'Not on the public site: the fly here can vote, but it cannot be taught, wiped, or post to GitHub.',
        });
        return;
      }
      if (input.action === 'review' && !allow(request, 'review')) {
        json(429, { error: 'That is all the reviews from here for this hour. The fly needs a break.' });
        return;
      }
      await review!.act(input);
      json(200, { ok: true });
      return;
    }
    if (request.method === 'GET' && files[path]) {
      const [file, contentType] = files[path];
      // Pages hand out the session cookie, so the requests they make in parallel all land in the same session.
      if (PUBLIC && contentType.startsWith('text/html')) visitor(request, response);
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(await readFile(join(ROOT, file)));
      return;
    }
    response.writeHead(404).end('Not found');
  } catch (error) {
    if (!response.headersSent) json(400, { error: String(error) });
    else response.end();
  }
});
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`fly-review: http://localhost:${port}${PUBLIC ? ' (public mode)' : ''}`);
  const state = local?.show.state;
  console.log(
    state
      ? `Jev: ${state.hasJev ? 'available' : 'TYPESAFE_API_KEY missing; explicit manual mode available'}. Investigator: ${state.hasInvestigator ? 'Anthropic available' : 'ANTHROPIC_API_KEY missing'}. GitHub: ${state.hasGitHub ? 'token found; private pull requests and posting enabled' : 'public pull requests only'}.`
      : `Jev: ${process.env.TYPESAFE_API_KEY ? `available, ${jevDaily} calls a day` : 'TYPESAFE_API_KEY missing'}. Public pull requests only; no teaching, forgetting, or posting.`,
  );
});

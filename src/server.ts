import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './io.ts';
import { ReviewShow } from './review-show.ts';
import type { ReviewAction } from './review-show.ts';

const port = Number(process.env.PORT ?? 4488);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const reviewClients = new Set<ServerResponse>();
const review = new ReviewShow(state => {
  const message = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of reviewClients) {
    if (client.writableLength > 2_000_000) { client.end(); reviewClients.delete(client); }
    else client.write(message);
  }
});
const files: Record<string, [string, string]> = {
  '/': ['web/review.html', 'text/html; charset=utf-8'],
  '/review.css': ['web/review.css', 'text/css; charset=utf-8'],
  '/review.js': ['.runtime/web/web/review.js', 'text/javascript; charset=utf-8'],
  '/brain-view.js': ['.runtime/web/web/brain-view.js', 'text/javascript; charset=utf-8'],
  '/src/brain-geometry.js': ['.runtime/web/src/brain-geometry.js', 'text/javascript; charset=utf-8'],
  '/anatomy.json': ['.runtime/review-anatomy.json', 'application/json'],
  '/src/review-cases.js': ['.runtime/web/src/review-cases.js', 'text/javascript; charset=utf-8'],
};
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  if (!origins.has(`http://${request.headers.host}`)) { response.writeHead(403).end('Localhost only'); return; }
  const path = request.url?.split('?')[0] ?? '/';
  const json = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
    if (request.method === 'GET' && path === '/review-events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(review.state)}\n\n`);
      reviewClients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => { reviewClients.delete(response); clearInterval(heartbeat); });
      return;
    }
    if (request.method === 'GET' && path === '/api/review/state') { json(200, review.state); return; }
    if (request.method === 'POST' && path === '/api/review/action') {
      if (!origins.has(request.headers.origin ?? '') || request.headers['content-type'] !== 'application/json') { json(403, { error: 'Same-origin JSON requests only' }); return; }
      if (review.busy) { json(409, { error: 'The current review operation is still running.' }); return; }
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 4096) { json(413, { error: 'Request too large' }); return; }
      }
      const input = JSON.parse(body) as ReviewAction;
      if (!input || !['review', 'disconnect', 'repeat', 'verify'].includes(input.action)) { json(400, { error: 'Unknown review action' }); return; }
      await review.act(input);
      json(200, { ok: true });
      return;
    }
    if (request.method === 'GET' && files[path]) {
      const [file, contentType] = files[path];
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(await readFile(join(ROOT, file)));
      return;
    }
    response.writeHead(404).end('Not found');
  } catch (error) { if (!response.headersSent) json(400, { error: String(error) }); else response.end(); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`fly-review: http://localhost:${port}`);
  console.log(`Jev: ${review.state.hasJev ? 'available' : 'TYPESAFE_API_KEY missing; explicit manual mode available'}. Investigator: ${review.state.hasInvestigator ? 'Anthropic available' : 'ANTHROPIC_API_KEY missing'}.`);
});

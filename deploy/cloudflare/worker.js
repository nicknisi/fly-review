// fruitfly.review: one Durable Object runs the fly-review container (the Dockerfile at the repo root, in public mode) and
// every request goes to it. The container is reachable only through here; this Worker stamps each request with the
// visitor's IP (x-fly-client) for the server's per-visitor limits, overwriting anything the visitor sent.
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
/** Sleep after this long without requests; the next visitor wakes it (a cold start is a few seconds). */
const IDLE_MS = 15 * 60_000;

export class FlyReview extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container.running) void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(IDLE_MS));
  }

  async fetch(request) {
    // Concurrent requests share one startup and readiness check; after that, requests go straight through.
    if (!this.ready || !this.ctx.container.running) {
      this.starting ??= this.start().finally(() => (this.starting = undefined));
      await this.starting;
    }
    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async start() {
    const container = this.ctx.container;
    this.ready = false;
    // Secrets reach the container only when it starts, so a container started with other secrets is replaced: after
    // `wrangler secret put`, the next request restarts it. Only a hash of the secrets is stored.
    const secrets = await fingerprint(this.env);
    if (container.running && (await this.ctx.storage.get('secrets')) !== secrets)
      await container.destroy('The secrets changed');
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: {
          TYPESAFE_API_KEY: this.env.TYPESAFE_API_KEY ?? '',
          // Optional: a token for public repositories only, to lift GitHub's anonymous rate limit.
          ...(this.env.GITHUB_TOKEN ? { GITHUB_TOKEN: this.env.GITHUB_TOKEN } : {}),
        },
      });
      await this.ctx.storage.put('secrets', secrets);
    }
    await container.setInactivityTimeout(IDLE_MS);
    const port = container.getTcpPort(PORT);
    let last;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) {
          this.ready = true;
          return;
        }
        last = new Error(`Health check returned ${response.status}`);
      } catch (error) {
        last = error;
      }
      await scheduler.wait(200);
    }
    throw new Error('The fly-review container did not become ready', { cause: last });
  }
}

async function fingerprint(env) {
  const bytes = new TextEncoder().encode(`${env.TYPESAFE_API_KEY ?? ''}\n${env.GITHUB_TOKEN ?? ''}`);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set('x-fly-client', request.headers.get('cf-connecting-ip') ?? 'unknown');
    return env.FLY.getByName('fly').fetch(new Request(request, { headers }));
  },
};

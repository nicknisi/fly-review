import { command } from './io.ts';
import type { ReviewCase } from './review-cases.ts';
import type { Attention } from './review-types.ts';
import type { FlyVerdict, Features, ReviewBrain } from './review-brain.ts';
import { PULL_REQUEST_CASE_ID, RECEPTORS, flyName } from './review-cases.ts';
export { PULL_REQUEST_CASE_ID };

/** Budget for what Jev is shown. Files past the budget are listed by name with their patch omitted. */
export const PR_LIMITS = { totalPatch: 60_000, filePatch: 12_000, files: 300, body: 4_000 };

export type PullRequestRef = { owner: string; repo: string; number: number };
export type PatchFile = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  omitted?: 'binary or too large' | 'over budget' | 'generated file' | 'renamed, no content change';
};
/** Lockfiles and build output would eat the encoder's budget without describing the change. */
const GENERATED =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap|lock)$|(^|\/)(dist|build|vendor|node_modules)\//;
export type PullRequest = {
  ref: PullRequestRef;
  url: string;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PatchFile[];
  shownPatchChars: number;
  fetchedAt: string;
};

/** Accepts https://github.com/o/r/pull/12, o/r#12, o/r/pull/12, or a bare pulls API path. */
export function parsePullRequestRef(input: unknown): PullRequestRef {
  if (typeof input !== 'string' || input.length > 300)
    throw new Error('Paste a GitHub pull request URL such as https://github.com/owner/repo/pull/123');
  const text = input.trim();
  const match =
    text.match(
      /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/pull\/|#)(\d{1,7})(?:[/?#].*)?$/,
    ) ??
    text.match(
      /^(?:https?:\/\/api\.github\.com\/)?repos\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/pulls\/(\d{1,7})$/,
    );
  if (!match)
    throw new Error('That does not look like a GitHub pull request. Try https://github.com/owner/repo/pull/123');
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
export const pullRequestKey = (ref: PullRequestRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

let cachedToken: string | null | undefined;
/** GITHUB_TOKEN, else the gh CLI's token if gh is installed and logged in, else unauthenticated public access. */
export async function githubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = (await command('gh', ['auth', 'token'], '', 10_000)).trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function github(path: string, init: RequestInit, fetcher: typeof fetch, token: string | null): Promise<Response> {
  return fetcher(`https://api.github.com${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fly-review',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export async function fetchPullRequest(
  ref: PullRequestRef,
  fetcher: typeof fetch = fetch,
  token?: string | null,
): Promise<PullRequest> {
  const auth = token === undefined ? await githubToken() : token;
  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const response = await github(base, {}, fetcher, auth);
  if (response.status === 404)
    throw new Error(
      `${pullRequestKey(ref)} was not found${auth ? '' : '. Private repositories need GITHUB_TOKEN or a logged-in gh CLI'}.`,
    );
  if (response.status === 403 || response.status === 429)
    throw new Error('GitHub rate limit or permission problem. Set GITHUB_TOKEN or log in with gh.');
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const pr = (await response.json()) as {
    html_url: string;
    title: string;
    body: string | null;
    user?: { login?: string };
    base: { ref: string };
    head: { ref: string };
    additions: number;
    deletions: number;
    changed_files: number;
  };
  const files: PatchFile[] = [];
  for (let page = 1; page <= Math.ceil(PR_LIMITS.files / 100); page++) {
    const list = await github(`${base}/files?per_page=100&page=${page}`, {}, fetcher, auth);
    if (!list.ok) throw new Error(`GitHub files HTTP ${list.status}`);
    const batch = (await list.json()) as {
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[];
    for (const f of batch) {
      const patch = typeof f.patch === 'string' ? f.patch : null;
      files.push({
        filename: f.filename,
        ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch,
        ...(patch !== null
          ? {}
          : {
              omitted:
                f.status === 'renamed' ? ('renamed, no content change' as const) : ('binary or too large' as const),
            }),
      });
    }
    if (batch.length < 100) break;
  }
  // Spend the patch budget in file order so what Jev sees is exactly what the page shows.
  let spent = 0;
  for (const file of files) {
    if (file.patch === null) continue;
    if (GENERATED.test(file.filename)) {
      file.patch = null;
      file.omitted = 'generated file';
      continue;
    }
    if (file.patch.length > PR_LIMITS.filePatch)
      file.patch = file.patch.slice(0, PR_LIMITS.filePatch) + '\n@@ patch truncated by fly-review @@';
    if (spent + file.patch.length > PR_LIMITS.totalPatch) {
      file.patch = null;
      file.omitted = 'over budget';
      continue;
    }
    spent += file.patch.length;
  }
  return {
    ref,
    url: pr.html_url,
    title: pr.title,
    body: (pr.body ?? '').slice(0, PR_LIMITS.body),
    author: pr.user?.login ?? 'unknown',
    base: pr.base.ref,
    head: pr.head.ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    files,
    shownPatchChars: spent,
    fetchedAt: new Date().toISOString(),
  };
}

/** A whole pull request as one review case. No contract, no oracle: the fly votes, nothing is verified or executed. */
export function pullRequestCase(pr: PullRequest): ReviewCase {
  const shown = pr.files.filter(f => f.patch !== null);
  return {
    id: PULL_REQUEST_CASE_ID,
    title: `${pullRequestKey(pr.ref)}: ${pr.title}`,
    group: 'Your pull request',
    filename: shown[0]?.filename ?? pr.files[0]?.filename ?? 'pull request',
    context: `Pull request ${pr.url} by ${pr.author}, merging ${pr.head} into ${pr.base}. ${pr.changedFiles} changed files, +${pr.additions} −${pr.deletions}.${pr.body ? `\n\nDescription:\n${pr.body}` : '\n\nNo description was provided.'}`,
    before: '',
    after: '',
    functionName: 'pullRequest',
    contract: null,
    parameters: [],
    oracle: null,
    format: 'text',
    custom: true,
    pullRequest: pr,
  };
}

export function reviewComment(
  pr: PullRequest,
  review: {
    features: Features;
    brain: ReviewBrain;
    verdict: FlyVerdict;
    encoderModel: string | null;
    source: 'jev' | 'manual';
    /** Where the fly looked when it read the pull request hunk by hunk. */
    attention?: Attention | null;
  },
): string {
  const v = review.verdict.verdict;
  const looked = review.attention?.units[review.attention.looked];
  const where = looked ? `${looked.filename}${looked.hunk === null ? '' : `, hunk ${looked.hunk + 1}`}` : null;
  const reached = review.verdict.behavior === 'reached';
  const title =
    v === 'changes_requested'
      ? 'Changes requested.'
      : v === 'no_objection'
        ? reached
          ? 'The fly reached for it.'
          : 'No objection.'
        : 'The fly abstains.';
  const quip =
    v === 'changes_requested'
      ? 'Explanation unavailable. Reviewer is a fruit fly.'
      : v === 'no_objection'
        ? reached
          ? 'Its proboscis came out. Please don’t put “a fly licked it” in the incident report.'
          : 'Please don’t put “a fly approved it” in the incident report.'
        : 'Not enough downstream activity to issue a verdict.';
  const noticed = RECEPTORS.filter(r => review.features[r.key] >= 0.5)
    .map(r => `${r.label.toLowerCase()} ${Math.round(review.features[r.key] * 100)}%`)
    .join(' · ');
  const properties = noticed || 'nothing above 50% on any of the thirty receptors';
  return [
    `### 🪰 fly/review: **${where ? `Looked at \`${where}\`. ${title}` : title}**`,
    `> ${quip}`,
    '',
    ...(looked && review.attention
      ? [
          `The fly read ${review.attention.units.length} ${review.attention.granularity}s in order, then read them again with its familiarity synapses frozen. \`${where}\` still evoked ${looked.reading.noveltyHz.toFixed(0)} Hz of its first-exposure ${looked.reading.naiveNoveltyHz.toFixed(0)} Hz on the α'3 novelty MBONs, the most of any, so that is the ${review.attention.granularity} it looked at and voted on. Novelty means unlike the rest of this diff, not wrong.`,
        ]
      : []),
    `Reviewer: ${flyName(review.brain.seed)}, 176,422 simulated neurons from the male *Drosophila* CNS connectome, taught only by executed tests (${review.brain.rememberedSynapses.toLocaleString()} synapses carry memory).`,
    review.source === 'jev'
      ? `${review.encoderModel ?? 'Jev'} described ${where ? 'that hunk' : 'this pull request'} (${properties}); the description and the changed tokens became an odor of ${Object.keys(review.brain.stimuli ?? {}).length} glomeruli.`
      : `Operator-set descriptors: ${properties}. No model read this code.`,
    `Mushroom body over 250 ms: ${review.brain.activeKenyon} Kenyon cells active; avoidance MBONs ${review.brain.avoidHz.toFixed(0)} Hz against approach ${review.brain.approachHz.toFixed(0)} Hz, share ${review.verdict.score.toFixed(2)} (objection at 0.68, approval at 0.45). Proboscis motor neurons ${review.brain.feedHz.toFixed(0)} Hz: the body ${reached ? 'reached for the smell' : 'stayed still'}.`,
    '',
    `This is a neural classification of ${pr.changedFiles} changed files (${pr.files.filter(f => f.patch !== null).length} shown to the encoder), not a bug report and not evidence of correctness. Nothing in this pull request was executed. The neural recording and inputs are saved locally by the reviewer’s fly-review instance.`,
  ].join('\n');
}

export async function postReview(
  pr: PullRequest,
  body: string,
  fetcher: typeof fetch = fetch,
  token?: string | null,
): Promise<{ url: string }> {
  const auth = token === undefined ? await githubToken() : token;
  if (!auth) throw new Error('Posting needs GITHUB_TOKEN or a logged-in gh CLI.');
  if (body.length > 60_000) throw new Error('Review comment too long');
  const response = await github(
    `/repos/${pr.ref.owner}/${pr.ref.repo}/pulls/${pr.ref.number}/reviews`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'COMMENT', body }),
    },
    fetcher,
    auth,
  );
  if (!response.ok)
    throw new Error(
      `GitHub refused the review: HTTP ${response.status}${response.status === 403 ? ' (the token cannot write to this repository)' : ''}`,
    );
  const result = (await response.json()) as { html_url?: string };
  if (typeof result.html_url !== 'string') throw new Error('GitHub did not return the review URL');
  return { url: result.html_url };
}

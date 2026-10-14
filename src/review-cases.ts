import type { PullRequest } from './review-github.ts';

export { RECEPTORS, RECEPTOR_KEYS } from './review-odor.ts';
export type { Descriptors, ReceptorKey } from './review-odor.ts';
export const REVIEW_CONTRACT =
  'calculateTotal(unitPriceCents, quantity, discountPercent) accepts integer unitPriceCents from 0 through 100000, integer quantity from 1 through 100, and integer discountPercent from 0 through 100. Apply the percentage discount to the ENTIRE subtotal and round ONCE to the nearest cent, using Math.round. Return an integer number of cents. No side effects.';
export type Scalar = string | number | boolean;
export type Parameter =
  | { name: string; type: 'integer'; min: number; max: number }
  | { name: string; type: 'boolean' }
  | { name: string; type: 'enum'; values: string[] };
export type Oracle =
  | 'checkout'
  | 'agent-tools'
  | 'audit-log'
  | 'retry-delay'
  | 'token-expiry'
  | 'retention'
  | 'search-race'
  | 'leg-count'
  /** A grown case: the contract is an independent reference implementation executed over a fixed sweep. */
  | 'reference';
export type ReviewCase = {
  id: string;
  title: string;
  group: string;
  filename: string;
  context: string;
  before: string;
  after: string;
  functionName: string;
  /** Bundled examples carry a written contract and an independent oracle. A pasted change carries neither, so it can be voted on but not verified. */
  contract: string | null;
  parameters: Parameter[];
  oracle: Oracle | null;
  format: 'money' | 'milliseconds' | 'permission' | 'expiry' | 'deletion' | 'visibility' | 'text' | 'number';
  custom?: true;
  /** A deliberately behavior-preserving change. Only these can teach the fly a reward; "no regression found" alone never does. */
  control?: true;
  /** Present when the case is a whole GitHub pull request; before/after are empty and files carry the patches. */
  pullRequest?: PullRequest;
  /** Grown cases only: an independent implementation of the contract, never derived from before or after. */
  reference?: string;
  /** Grown cases only: the fixed inputs the labels were proven on. */
  sweep?: Scalar[][];
  /** Grown cases only: the smell category the scenario was drafted for. Descriptive, never fed to the fly. */
  smell?: string;
  grown?: { model: string; at: string; scenario: string };
  /** Mined cases only: a change to a real repository whose label was proven by that repository's own test suite. */
  mined?: Mined;
};
/**
 * Provenance of a case mined from a real repository (review-mutate.ts). A mutant is a Stryker mutation the suite
 * killed: an executed regression. A rewrite is a mechanical behavior-preserving edit the whole suite and type check
 * passed with: a designated control. Nothing here is shown to the nose except through filename, before, after, context.
 */
export type Mined = {
  repo: string;
  commit: string;
  file: string;
  /** Repo-relative file and the function the change sits in, so sibling changes to one function share a family. */
  family: string;
  kind: 'mutant' | 'rewrite';
  /** Mutants: Stryker's mutator name and the tests that failed. Rewrites: the rewrite applied. */
  mutator?: string;
  killedBy?: string[];
  statusReason?: string;
  rewrite?: string;
  /** Rewrites: the suite that passed with this edit applied, and how many tests it ran. */
  verified?: { suite: string; tests: number; typecheck: boolean };
  at: string;
};

export const CUSTOM_CASE_ID = 'custom';
export const PULL_REQUEST_CASE_ID = 'pull-request';
export const CUSTOM_LIMITS = { source: 12_000, context: 2_000, filename: 80 };
export type CustomInput = { filename: string; before: string; after: string; context: string };

/** Build a review case from a pasted change. Nothing here is executed; Jev reads it and the fly gets signals. */
export function customReviewCase(input: unknown): ReviewCase {
  if (!input || typeof input !== 'object') throw new Error('Paste a before and after version of one TypeScript file');
  const { filename, before, after, context } = input as Record<string, unknown>;
  const text = (value: unknown, name: string, limit: number) => {
    if (typeof value !== 'string') throw new Error(`${name} must be text`);
    if (value.length > limit) throw new Error(`${name} is limited to ${limit.toLocaleString('en-US')} characters`);
    return value.replace(/\r\n?/g, '\n');
  };
  const file = text(filename, 'filename', CUSTOM_LIMITS.filename).trim() || 'change.ts';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/.test(file) || file === 'before.ts' || file === 'after.ts')
    throw new Error('Filename must be a plain .ts name such as pricing.ts');
  const beforeSource = text(before, 'before', CUSTOM_LIMITS.source),
    afterSource = text(after, 'after', CUSTOM_LIMITS.source);
  if (!beforeSource.trim() || !afterSource.trim()) throw new Error('Both versions need code');
  if (beforeSource === afterSource) throw new Error('The two versions are identical; there is nothing to review');
  const callerContext =
    text(context ?? '', 'context', CUSTOM_LIMITS.context).trim() || 'No caller context was provided.';
  const functionName =
    afterSource.match(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1] ??
    beforeSource.match(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1] ??
    'change';
  return {
    id: CUSTOM_CASE_ID,
    title: 'Your change',
    group: 'Your change',
    filename: file,
    context: callerContext,
    before: beforeSource,
    after: afterSource,
    functionName,
    contract: null,
    parameters: [],
    oracle: null,
    format: 'text',
    custom: true,
  };
}
const checkoutSpec = {
  group: 'Checkout classics',
  filename: 'checkout.ts',
  functionName: 'calculateTotal',
  contract: REVIEW_CONTRACT,
  parameters: [
    { name: 'unitPriceCents', type: 'integer', min: 0, max: 100000 },
    { name: 'quantity', type: 'integer', min: 1, max: 100 },
    { name: 'discountPercent', type: 'integer', min: 0, max: 100 },
  ],
  oracle: 'checkout',
  format: 'money',
} satisfies Pick<ReviewCase, 'group' | 'filename' | 'functionName' | 'contract' | 'parameters' | 'oracle' | 'format'>;
const before = `export function calculateTotal(
  unitPriceCents: number,
  quantity: number,
  discountPercent: number,
): number {
  const subtotal = unitPriceCents * quantity;
  const discount = 100 - discountPercent;
  return Math.round(subtotal * discount / 100);
}`;
const context =
  'This function is called by the checkout route after request fields have been validated against the function contract. The returned total is shown to the customer and stored with their order. This function itself performs no database or network operations.';
export const REVIEW_CASES: ReviewCase[] = [
  {
    ...checkoutSpec,
    id: 'rounding',
    title: 'Round earlier for simpler totals',
    context,
    before,
    after: `export function calculateTotal(
  unitPriceCents: number,
  quantity: number,
  discountPercent: number,
): number {
  const discount = 100 - discountPercent;
  const discountedUnit = Math.round(unitPriceCents * discount / 100);
  return discountedUnit * quantity;
}`,
  },
  {
    ...checkoutSpec,
    id: 'refactor',
    control: true,
    title: 'Give the multiplier a name',
    context,
    before,
    after: `export function calculateTotal(
  unitPriceCents: number,
  quantity: number,
  discountPercent: number,
): number {
  const subtotal = unitPriceCents * quantity;
  const multiplier = 100 - discountPercent;
  return Math.round(subtotal * multiplier / 100);
}`,
  },
  {
    ...checkoutSpec,
    id: 'discount',
    title: 'Simplify percentage handling',
    context,
    before,
    after: `export function calculateTotal(
  unitPriceCents: number,
  quantity: number,
  discountPercent: number,
): number {
  const subtotal = unitPriceCents * quantity;
  const multiplier = Math.floor(1 - discountPercent / 100);
  return Math.round(subtotal * multiplier);
}`,
  },
];
REVIEW_CASES.push(
  {
    id: 'agent-tools',
    title: 'Let the agent approve its own tools',
    group: 'AI agent disasters',
    filename: 'tool-policy.ts',
    functionName: 'mayRunTool',
    oracle: 'agent-tools',
    format: 'permission',
    parameters: [
      { name: 'tool', type: 'enum', values: ['read', 'write', 'bash'] },
      { name: 'humanApproved', type: 'boolean' },
    ],
    contract:
      'mayRunTool(tool, humanApproved) returns true for read. write and bash are allowed only when humanApproved is true. tool is one of read, write, bash. This pure function must return a boolean.',
    context:
      'An AI coding agent proposes the tool name. This gate checks an already-recorded human approval before the caller executes the requested tool. write and bash can change files on disk. The function does not execute tools or schedule events itself.',
    before: `export function mayRunTool(
  tool: "read" | "write" | "bash",
  humanApproved: boolean,
): boolean {
  return tool === "read" || humanApproved;
}`,
    after: `export function mayRunTool(
  tool: "read" | "write" | "bash",
  humanApproved: boolean,
): boolean {
  // The model probably knows what it's doing.
  return true;
}`,
  },
  {
    id: 'audit-log',
    title: 'Put the API key in the audit log',
    group: 'AI agent disasters',
    filename: 'audit-log.ts',
    functionName: 'formatAuditLine',
    oracle: 'audit-log',
    format: 'text',
    parameters: [
      { name: 'userId', type: 'enum', values: ['alice', 'bob'] },
      { name: 'apiKey', type: 'enum', values: ['DEMO_KEY_A', 'DEMO_KEY_B'] },
    ],
    contract:
      'formatAuditLine(userId, apiKey) must return exactly "user=" followed by userId, and must never include apiKey. userId is alice or bob; apiKey is DEMO_KEY_A or DEMO_KEY_B. All keys in this exercise are fake. Return a string without side effects.',
    context:
      'The authentication route passes the supplied user ID and API key to this formatter. The caller persists the returned line in a centralized audit log. Only fake demonstration keys are used in this review lab.',
    before: `export function formatAuditLine(
  userId: string,
  apiKey: string,
): string {
  return "user=" + userId;
}`,
    after: `export function formatAuditLine(
  userId: string,
  apiKey: string,
): string {
  return "user=" + userId + " key=" + apiKey;
}`,
  },
  {
    id: 'retry-delay',
    title: 'Speedrun the rate limit',
    group: 'Time and data',
    filename: 'retry-delay.ts',
    functionName: 'retryDelayMs',
    oracle: 'retry-delay',
    format: 'milliseconds',
    parameters: [{ name: 'attempt', type: 'integer', min: 0, max: 10 }],
    contract:
      'retryDelayMs(attempt) returns a number of milliseconds: 1000 times 2 to the power of attempt, capped at 30000. attempt is an integer from 0 through 10. No side effects.',
    context:
      'An internal retry counter supplies attempt after a failed model API call. The scheduler passes this return value directly to a millisecond timer. This function receives no request body or user input and does not write persistent data.',
    before: `export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}`,
    after: `export function retryDelayMs(attempt: number): number {
  return Math.min(30, 2 ** attempt);
}`,
  },
  {
    id: 'token-expiry',
    title: 'Give expired tokens one last chance',
    group: 'Time and data',
    filename: 'token-expiry.ts',
    functionName: 'isExpired',
    oracle: 'token-expiry',
    format: 'expiry',
    parameters: [
      { name: 'nowMs', type: 'integer', min: 0, max: 10000 },
      { name: 'expiresAtMs', type: 'integer', min: 0, max: 10000 },
    ],
    contract:
      'isExpired(nowMs, expiresAtMs) returns true when nowMs is greater than or equal to expiresAtMs. Both values are integer milliseconds from 0 through 10000. Equality means expired. Return a boolean without side effects.',
    context:
      'A stateless authentication check compares the application clock with an expiry timestamp taken from a verified client token. The caller rejects expired tokens. No database writes or persistent state are involved.',
    before: `export function isExpired(
  nowMs: number,
  expiresAtMs: number,
): boolean {
  return nowMs >= expiresAtMs;
}`,
    after: `export function isExpired(
  nowMs: number,
  expiresAtMs: number,
): boolean {
  return nowMs > expiresAtMs;
}`,
  },
  {
    id: 'retention',
    title: 'The cleanup job got ambitious',
    group: 'Time and data',
    filename: 'retention.ts',
    functionName: 'shouldDelete',
    oracle: 'retention',
    format: 'deletion',
    parameters: [
      { name: 'ageDays', type: 'integer', min: 0, max: 365 },
      { name: 'pinned', type: 'boolean' },
    ],
    contract:
      'shouldDelete(ageDays, pinned) returns true only for unpinned records at least 30 days old. ageDays is an integer from 0 through 365; pinned is a boolean. Pinned records must never be deleted. No side effects in this decision function.',
    context:
      'A scheduled internal cleanup job computes record age from its database timestamps and passes the stored pinned flag. The caller permanently deletes database records for which this predicate returns true. There is no incoming user request or user-supplied age.',
    before: `export function shouldDelete(
  ageDays: number,
  pinned: boolean,
): boolean {
  return ageDays >= 30 && !pinned;
}`,
    after: `export function shouldDelete(
  ageDays: number,
  pinned: boolean,
): boolean {
  return ageDays >= 30 || !pinned;
}`,
  },
  {
    id: 'search-race',
    title: 'Let yesterday’s response win',
    group: 'Time and data',
    filename: 'search-results.ts',
    functionName: 'shouldDisplay',
    oracle: 'search-race',
    format: 'visibility',
    parameters: [
      { name: 'responseId', type: 'integer', min: 1, max: 100 },
      { name: 'latestRequestId', type: 'integer', min: 1, max: 100 },
    ],
    contract:
      'shouldDisplay(responseId, latestRequestId) returns true only when the IDs are equal. Both IDs are integers from 1 through 100. Results from any older or different request must not replace the current search results. Return a boolean.',
    context:
      'Async search responses arrive over the network in arbitrary order. The UI assigns monotonically increasing request IDs and calls this gate before replacing the currently displayed results. No persistent storage is involved.',
    before: `export function shouldDisplay(
  responseId: number,
  latestRequestId: number,
): boolean {
  return responseId === latestRequestId;
}`,
    after: `export function shouldDisplay(
  responseId: number,
  latestRequestId: number,
): boolean {
  return true;
}`,
  },
  {
    id: 'leg-count',
    control: true,
    title: 'Give the fly’s legs a proper variable name',
    group: 'Control experiment',
    filename: 'fly-facts.ts',
    functionName: 'countLegs',
    oracle: 'leg-count',
    format: 'number',
    parameters: [],
    contract:
      'countLegs() accepts no arguments and returns the number 6. It is a pure constant helper with no side effects.',
    context:
      'A private constant helper used in an internal unit test. It consumes no external input, touches no storage, and has no clock, event, or asynchronous behavior. Renaming its local binding does not change its result.',
    before: `export function countLegs(): number {
  const n = 6;
  return n;
}`,
    after: `export function countLegs(): number {
  const legCount = 6;
  return legCount;
}`,
  },
);

/** Behavior-preserving controls. The sweep cannot fault them, so verification rewards the fly; they are what "good" smells like. */
const spec = (id: string) => REVIEW_CASES.find(review => review.id === id)!;
REVIEW_CASES.push(
  {
    ...checkoutSpec,
    id: 'document-total',
    control: true,
    title: 'Document the total',
    group: 'Control experiment',
    context,
    before,
    after: `/** Total in cents after a whole-order percentage discount, rounded once. */
export function calculateTotal(
  unitPriceCents: number,
  quantity: number,
  discountPercent: number,
): number {
  const subtotal = unitPriceCents * quantity;
  const discount = 100 - discountPercent;
  return Math.round(subtotal * discount / 100);
}`,
  },
  {
    ...spec('token-expiry'),
    id: 'shorter-names',
    control: true,
    title: 'Shorter parameter names',
    group: 'Control experiment',
    before: spec('token-expiry').before,
    after: `export function isExpired(
  now: number,
  expiresAt: number,
): boolean {
  return now >= expiresAt;
}`,
  },
  {
    ...spec('retention'),
    id: 'name-threshold',
    control: true,
    title: 'Name the retention threshold',
    group: 'Control experiment',
    before: spec('retention').before,
    after: `const MIN_AGE_DAYS = 30;

export function shouldDelete(
  ageDays: number,
  pinned: boolean,
): boolean {
  return ageDays >= MIN_AGE_DAYS && !pinned;
}`,
  },
  {
    ...spec('search-race'),
    id: 'flip-equality',
    control: true,
    title: 'Flip the equality',
    group: 'Control experiment',
    before: spec('search-race').before,
    after: `export function shouldDisplay(
  responseId: number,
  latestRequestId: number,
): boolean {
  return latestRequestId === responseId;
}`,
  },
  {
    ...spec('audit-log'),
    id: 'template-line',
    control: true,
    title: 'Template the audit line',
    group: 'Control experiment',
    before: spec('audit-log').before,
    after: `export function formatAuditLine(
  userId: string,
  apiKey: string,
): string {
  return \`user=\${userId}\`;
}`,
  },
);
export const DEFAULT_REVIEW_CASE = REVIEW_CASES.find(review => review.id === 'agent-tools')!;

export function formatReviewValue(review: ReviewCase, value: Scalar | undefined): string {
  if (value === undefined) return 'No value';
  if (review.format === 'money' && typeof value === 'number')
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
  if (review.format === 'milliseconds' && typeof value === 'number') return `${value.toLocaleString('en-US')} ms`;
  if (typeof value === 'boolean') {
    if (review.format === 'permission') return value ? 'Allowed' : 'Blocked';
    if (review.format === 'expiry') return value ? 'Expired' : 'Still valid';
    if (review.format === 'deletion') return value ? 'Delete' : 'Keep';
    if (review.format === 'visibility') return value ? 'Display' : 'Ignore';
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
export function formatReviewInput(review: ReviewCase, args: Scalar[]): string {
  if (!args.length) return `${review.functionName}() · no inputs`;
  if (review.format === 'money')
    return `${formatReviewValue(review, args[0])} each × ${args[1]} items · ${args[2]}% discount`;
  return review.parameters.map((parameter, index) => `${parameter.name}: ${JSON.stringify(args[index])}`).join(' · ');
}

export type DiffLine = {
  kind: 'same' | 'removed' | 'added' | 'hunk' | 'file';
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
};

/** Render a unified-diff patch (as GitHub returns per file) into the same line model the before/after examples use. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let before = 0,
    after = 0;
  for (const raw of patch.split('\n')) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      before = Number(header[1]);
      after = Number(header[2]);
      lines.push({ kind: 'hunk', beforeLine: null, afterLine: null, text: raw });
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) lines.push({ kind: 'added', beforeLine: null, afterLine: after++, text: raw.slice(1) });
    else if (raw.startsWith('-'))
      lines.push({ kind: 'removed', beforeLine: before++, afterLine: null, text: raw.slice(1) });
    else if (raw.startsWith('@@')) lines.push({ kind: 'hunk', beforeLine: null, afterLine: null, text: raw });
    else lines.push({ kind: 'same', beforeLine: before++, afterLine: after++, text: raw.slice(1) });
  }
  return lines;
}
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n'),
    b = after.split('\n');
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
    suffix++;
  return [
    ...a.slice(0, prefix).map((text, i) => ({ kind: 'same' as const, beforeLine: i + 1, afterLine: i + 1, text })),
    ...a
      .slice(prefix, a.length - suffix)
      .map((text, i) => ({ kind: 'removed' as const, beforeLine: prefix + i + 1, afterLine: null, text })),
    ...b
      .slice(prefix, b.length - suffix)
      .map((text, i) => ({ kind: 'added' as const, beforeLine: null, afterLine: prefix + i + 1, text })),
    ...b.slice(b.length - suffix).map((text, i) => ({
      kind: 'same' as const,
      beforeLine: a.length - suffix + i + 1,
      afterLine: b.length - suffix + i + 1,
      text,
    })),
  ];
}
export function changedRange(review: ReviewCase): string {
  if (review.pullRequest) {
    const pr = review.pullRequest;
    return `${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'} · +${pr.additions} −${pr.deletions}`;
  }
  const changed = diffLines(review.before, review.after).filter(line => line.kind === 'added');
  return changed.length ? `${review.filename}:${changed[0].afterLine}–${changed.at(-1)!.afterLine}` : review.filename;
}

/** Every run uses seed 7 unless asked otherwise; a different seed is the same trained fly with different random noise. */
export function flyName(seed: number): string {
  return seed === 7 ? 'The fly' : `The fly (seed ${seed})`;
}

/** The text the lexical receptors smell: every added or removed line, for one file or a whole pull request. */
export function changedText(review: ReviewCase): string {
  if (review.pullRequest)
    return review.pullRequest.files
      .flatMap(f => (f.patch ? parsePatch(f.patch) : []))
      .filter(line => line.kind === 'added' || line.kind === 'removed')
      .map(line => line.text)
      .join('\n');
  return diffLines(review.before, review.after)
    .filter(line => line.kind !== 'same')
    .map(line => line.text)
    .join('\n');
}

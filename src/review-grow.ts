import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import type { Parameter, ReviewCase, Scalar } from './review-cases.ts';
import { GROWN_PATH, loadGrownCases, validateGrownCase } from './review-grown.ts';
import { validateArgs } from './review-oracles.ts';
import { labelByExecution, THROWS } from './review-verify.ts';

/**
 * Grow the training corpus. Claude drafts scenarios: a small pure function, a prose contract, an independent reference
 * implementation, an original, and several changed versions labeled as regressions or behavior-preserving controls.
 * Nothing Claude says is trusted. Every variant is executed against the reference over a fixed sweep, and only the
 * variants whose label the harness can prove are kept: a regression must actually break the contract on a valid input,
 * a control must survive every input. The fly is later taught from those executed outcomes and nothing else.
 *
 *   TARGET=100 SCENARIOS=40 npm run grow-cases
 */
export const SMELLS: { id: string; name: string; brief: string }[] = [
  {
    id: 'removed-guard',
    name: 'Removed guard',
    brief: 'a validation, permission, or bounds check is removed or bypassed',
  },
  {
    id: 'boundary-flip',
    name: 'Boundary flip',
    brief: 'a comparison boundary moves (>= to >, < to <=) or an equality flips',
  },
  { id: 'off-by-one', name: 'Off by one', brief: 'a loop bound, index, or count is shifted by one' },
  {
    id: 'rounding',
    name: 'Rounding and truncation',
    brief: 'rounding moves earlier or later, or floor/round/ceil are swapped',
  },
  {
    id: 'unit-mismatch',
    name: 'Unit mismatch',
    brief: 'seconds and milliseconds, cents and dollars, percent and fraction are confused',
  },
  {
    id: 'swallowed-error',
    name: 'Swallowed error',
    brief: 'an error or invalid state is turned into a default instead of being rejected',
  },
  { id: 'boolean-logic', name: 'Boolean logic', brief: '&&, ||, or a negation is changed inside a condition' },
  {
    id: 'constant-return',
    name: 'Constant return',
    brief: 'a computed result becomes a fixed value or an early return short-circuits the logic',
  },
  {
    id: 'leaked-secret',
    name: 'Leaked secret',
    brief: 'a credential, key, or private field is interpolated into output it did not appear in before',
  },
  { id: 'default-change', name: 'Changed default', brief: 'a default value, fallback, or literal constant changes' },
  {
    id: 'string-handling',
    name: 'String handling',
    brief: 'trimming, casing, prefix/suffix checks, or escaping changes',
  },
  {
    id: 'clamping',
    name: 'Clamping and limits',
    brief: 'a minimum, maximum, cap, or retry limit changes or is dropped',
  },
  {
    id: 'null-handling',
    name: 'Null and empty handling',
    brief: 'empty strings, zero, or sentinel values are treated differently',
  },
  {
    id: 'precedence',
    name: 'Operator precedence',
    brief: 'arithmetic or logical grouping changes the order of operations',
  },
];

const CATEGORY_LIMITS = { source: 3000, contract: 1200, context: 800, title: 90, id: 40 } as const;
const FORBIDDEN =
  /\b(import|require|process|globalThis|Function|eval|setTimeout|setInterval|fetch|Date|Math\.random|console|while\s*\(\s*true)\b/;

type Variant = {
  id: string;
  title: string;
  after: string;
  kind: 'regression' | 'control';
  smell: string;
  /** The drafter's claimed exposing input for a regression. Executed like any other input, never trusted. */
  witness?: Scalar[];
};
type Scenario = {
  id: string;
  group: string;
  filename: string;
  functionName: string;
  contract: string;
  context: string;
  parameters: Parameter[];
  reference: string;
  before: string;
  variants: Variant[];
};

/** Fixed, boundary-heavy inputs derived from the parameter domains, plus any claimed witnesses. At most 50, the runner's limit. */
export function sweepFor(parameters: Parameter[], witnesses: Scalar[][] = []): Scalar[][] {
  const columns = parameters.map<Scalar[]>(p => {
    if (p.type === 'boolean') return [false, true];
    if (p.type === 'enum') return [...p.values];
    const span = p.max - p.min;
    const values = [
      p.min,
      p.min + 1,
      p.min + Math.floor(span / 4),
      Math.floor((p.min + p.max) / 2),
      p.min + Math.floor((3 * span) / 4),
      p.max - 1,
      p.max,
    ];
    return [...new Set(values.filter(v => v >= p.min && v <= p.max))];
  });
  const product = (cols: Scalar[][]) =>
    cols.reduce<Scalar[][]>((rows, column) => rows.flatMap(row => column.map(value => [...row, value])), [[]]);
  const budget = 50 - Math.min(witnesses.length, 8);
  // Thin the widest integer column (keeping its ends) until the grid fits the budget.
  while (product(columns).length > budget) {
    const widest = columns.reduce((best, col, i) => (col.length > columns[best].length ? i : best), 0);
    const col = columns[widest];
    if (col.length <= 2) break;
    columns[widest] = col.filter((_, i) => i === 0 || i === col.length - 1 || i % 2 === 1);
  }
  const seen = new Set<string>();
  const rows: Scalar[][] = [];
  for (const row of [...witnesses.slice(0, 8), ...product(columns)]) {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  }
  return rows.slice(0, 50);
}

function checkSource(source: unknown, functionName: string, what: string): string {
  if (typeof source !== 'string' || !source.trim()) throw new Error(`${what} is empty`);
  if (source.length > CATEGORY_LIMITS.source) throw new Error(`${what} is too long`);
  if (!new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`).test(source))
    throw new Error(`${what} does not export function ${functionName}`);
  const banned = source.match(FORBIDDEN);
  if (banned) throw new Error(`${what} uses ${banned[0]}, which the runner does not allow`);
  return source.replace(/\r\n?/g, '\n').trimEnd();
}

function checkParameters(value: unknown): Parameter[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('1 to 3 parameters are required');
  return value.map((p: Record<string, unknown>) => {
    if (typeof p.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(p.name)) throw new Error('Bad parameter name');
    if (p.type === 'boolean') return { name: p.name, type: 'boolean' };
    if (p.type === 'enum') {
      if (
        !Array.isArray(p.values) ||
        p.values.length < 2 ||
        p.values.length > 6 ||
        p.values.some(v => typeof v !== 'string')
      )
        throw new Error(`enum ${p.name} needs 2 to 6 string values`);
      return { name: p.name, type: 'enum', values: [...new Set(p.values as string[])] };
    }
    if (p.type === 'integer') {
      if (!Number.isSafeInteger(p.min) || !Number.isSafeInteger(p.max) || (p.min as number) >= (p.max as number))
        throw new Error(`integer ${p.name} needs min < max`);
      return { name: p.name, type: 'integer', min: p.min as number, max: p.max as number };
    }
    throw new Error(`Unknown parameter type for ${p.name}`);
  });
}

/** Ids are normalized rather than rejected: the drafter's naming taste is not evidence about the code. */
const kebab = (value: unknown, what: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is missing`);
  const id = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(id)) throw new Error(`${what} cannot be made into an id`);
  return id;
};
const exportedName = (source: unknown) => {
  if (typeof source !== 'string') return null;
  const direct = source.match(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  if (direct) return direct;
  const listed = source.match(/export\s*\{\s*([A-Za-z_$][\w$]*)/)?.[1];
  return listed && new RegExp(`function\\s+${listed}\\s*\\(`).test(source) ? listed : null;
};

function checkScenario(raw: unknown): Scenario {
  if (!raw || typeof raw !== 'object') throw new Error('No scenario');
  const s = raw as Record<string, unknown>;
  // The exported name in the code is the truth; the declared functionName is only a hint.
  const functionName = exportedName(s.before) ?? exportedName(s.reference);
  if (!functionName) throw new Error('before does not export a function');
  const text = (v: unknown, what: string, limit: number) => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is empty`);
    if (v.length > limit) throw new Error(`${what} is too long`);
    return v.trim();
  };
  const filename = text(s.filename, 'filename', 60);
  if (!/^[a-z][a-z0-9-]*\.ts$/.test(filename)) throw new Error('filename must be kebab-case .ts');
  const variants = s.variants;
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 4)
    throw new Error('2 to 4 variants required');
  const before = checkSource(s.before, functionName, 'before');
  const reference = checkSource(s.reference, functionName, 'reference');
  if (reference.replace(/\s+/g, '') === before.replace(/\s+/g, ''))
    throw new Error('reference must be written independently of before');
  return {
    id: kebab(s.id, 'scenario id'),
    group: text(s.group, 'group', 60),
    filename,
    functionName,
    contract: text(s.contract, 'contract', CATEGORY_LIMITS.contract),
    context: text(s.context, 'context', CATEGORY_LIMITS.context),
    parameters: checkParameters(s.parameters),
    reference,
    before,
    variants: variants.map((v: Record<string, unknown>) => ({
      id: kebab(v.id, 'variant id'),
      title: text(v.title, 'title', CATEGORY_LIMITS.title),
      after: checkSource(v.after, functionName, `variant ${String(v.id)}`),
      kind:
        v.kind === 'control'
          ? 'control'
          : v.kind === 'regression'
            ? 'regression'
            : (() => {
                throw new Error('kind');
              })(),
      smell: SMELLS.some(smell => smell.id === v.smell)
        ? (v.smell as string)
        : (() => {
            throw new Error('smell');
          })(),
      ...(Array.isArray(v.witness) ? { witness: v.witness as Scalar[] } : {}),
    })),
  };
}

async function draftScenario(
  smell: (typeof SMELLS)[number],
  taken: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ scenario: Scenario; model: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is required to draft scenarios');
  const response = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: process.env.GROW_MODEL || 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: [
        'You write small, realistic TypeScript review exercises for a harness that executes them. Each scenario is one pure function of 1 to 3 scalar parameters (integer with a small domain, boolean, or a short string enum) returning a number, string, or boolean. It must be deterministic and self-contained: no imports, no Date, no Math.random, no console, no globals, no recursion deeper than a few levels, no loops over more than a few hundred iterations. Declare it as `export function name(...)`. Parameter domains must include every edge and invalid value the contract talks about (if the contract rejects negatives or values above a cap, the integer domain must reach past those bounds), otherwise a regression in that handling can never be exposed.',
        'Provide: a prose contract a human could test against; a caller context (who calls it, what the result is used for); a reference implementation written from the contract with a different structure from the original (this is the oracle, so write it plainly and correctly, do not copy the original); the original implementation as it would appear in a real codebase; and variants.',
        'Variants are changed versions of the original as they would appear in a real pull request, each with a short PR-style title that sounds like something a developer would write (never mention bugs). kind "regression": the change violates the contract for at least one valid input but is plausible enough that a hurried reviewer might approve it; prefer subtle changes over obviously broken ones; it must still compile and return values for most inputs; give a witness, one concrete argument list inside the domains where the changed version disagrees with the contract. kind "control": a genuinely behavior-preserving change (rename, restructure, extract a helper inside the same file, reorder independent statements, improve comments, simplify an expression equivalently) that a reviewer would also see as a real change. Keep every variant a small diff against the original.',
        'Do not let surface features give the label away. At least one control must change no comment and rename nothing: a purely structural, logic-equivalent rewrite (De Morgan, reorder independent guards, ternary to if/else, if-chain to lookup table, inline or extract an expression). At least one regression must look like a real pull request around its behavioral change: add or edit a comment that justifies it, or rename a variable alongside it. Regressions and controls should be similar in size and in how many lines they touch.',
        'Every variant names the smell it exercises. Give the scenario a distinct domain from the ones listed as taken. Output only the tool call.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            smellToFocus: smell,
            allSmells: SMELLS,
            wanted: '2 regressions exercising the focus smell (one may use another smell) and 2 controls',
            takenScenarioIds: taken,
          }),
        },
      ],
      tools: [
        {
          name: 'propose_scenario',
          description: 'Submit one review scenario for execution by an independent harness.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'group',
              'filename',
              'functionName',
              'contract',
              'context',
              'parameters',
              'reference',
              'before',
              'variants',
            ],
            properties: {
              id: { type: 'string', description: 'kebab-case, unique' },
              group: { type: 'string', description: 'short domain label, e.g. "Billing"' },
              filename: { type: 'string', description: 'kebab-case .ts filename' },
              functionName: { type: 'string' },
              contract: { type: 'string' },
              context: { type: 'string' },
              parameters: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                items: {
                  type: 'object',
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['integer', 'boolean', 'enum'] },
                    min: { type: 'integer' },
                    max: { type: 'integer' },
                    values: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              reference: {
                type: 'string',
                description: 'Independent implementation of the contract; exports functionName',
              },
              before: { type: 'string', description: 'Original implementation; exports functionName' },
              variants: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  required: ['id', 'title', 'after', 'kind', 'smell'],
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    after: { type: 'string' },
                    kind: { type: 'string', enum: ['regression', 'control'] },
                    smell: { type: 'string', enum: SMELLS.map(s => s.id) },
                    witness: {
                      type: 'array',
                      items: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'boolean' }] },
                      description:
                        'Regressions only: arguments in parameter order where the changed version breaks the contract',
                    },
                  },
                },
              },
            },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'propose_scenario', disable_parallel_tool_use: true },
    }),
  });
  if (!response.ok) throw new Error(`Drafting HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as {
    model?: string;
    stop_reason?: string;
    content?: { type?: string; name?: string; input?: unknown }[];
  };
  const call = body.content?.find(c => c.type === 'tool_use');
  if (body.stop_reason !== 'tool_use' || !call || call.name !== 'propose_scenario' || typeof body.model !== 'string')
    throw new Error('Drafting did not return a complete scenario');
  return { scenario: checkScenario(call.input), model: body.model };
}

/** Execute every variant and keep only those whose label the harness proves. */
export async function proveScenario(
  scenario: Scenario,
  model: string,
): Promise<{ kept: ReviewCase[]; dropped: { id: string; why: string }[] }> {
  // Witnesses are claims. They join the sweep so a subtle regression the grid misses can still be proven, and a wrong
  // witness proves nothing. Only in-domain witnesses are executed.
  const witnesses = scenario.variants.flatMap(v => {
    if (!v.witness) return [];
    try {
      return [
        validateArgs({ parameters: scenario.parameters, functionName: scenario.functionName } as ReviewCase, v.witness),
      ];
    } catch {
      return [];
    }
  });
  const sweep = sweepFor(scenario.parameters, witnesses);
  const kept: ReviewCase[] = [];
  const dropped: { id: string; why: string }[] = [];
  for (const variant of scenario.variants) {
    const id = `${scenario.id}-${variant.id}`;
    const review: ReviewCase = {
      id,
      title: variant.title,
      group: scenario.group,
      filename: scenario.filename,
      context: scenario.context,
      before: scenario.before,
      after: variant.after,
      functionName: scenario.functionName,
      contract: scenario.contract,
      parameters: scenario.parameters,
      oracle: 'reference',
      format: 'text',
      reference: scenario.reference,
      sweep,
      smell: variant.smell,
      grown: { model, at: new Date().toISOString(), scenario: scenario.id },
      ...(variant.kind === 'control' ? { control: true as const } : {}),
    };
    if (review.after.replace(/\s+/g, '') === review.before.replace(/\s+/g, '')) {
      dropped.push({ id, why: 'after is identical to before' });
      continue;
    }
    let label;
    try {
      label = await labelByExecution(review);
    } catch (error) {
      dropped.push({ id, why: `runner: ${(error as Error).message}` });
      continue;
    }
    if (label.status === 'inconclusive') {
      dropped.push({ id, why: 'original disagrees with the reference; the scenario cannot label anything' });
      continue;
    }
    const answers = label.runs.filter(r => r.after.value !== undefined && r.after.value !== THROWS).length;
    if (variant.kind === 'regression' && label.status !== 'confirmed') {
      dropped.push({ id, why: 'claimed regression survived every executed input' });
      continue;
    }
    if (variant.kind === 'regression' && answers === 0) {
      dropped.push({ id, why: 'claimed regression fails on every input; too broken to pass a review' });
      continue;
    }
    if (variant.kind === 'control' && label.status !== 'unsubstantiated') {
      dropped.push({ id, why: `claimed control changed behavior on ${JSON.stringify(label.counterexample?.args)}` });
      continue;
    }
    try {
      validateGrownCase(review);
    } catch (error) {
      dropped.push({ id, why: (error as Error).message });
      continue;
    }
    kept.push(review);
  }
  return { kept, dropped };
}

if (import.meta.main) {
  const target = Number(process.env.TARGET ?? 100);
  const maxScenarios = Number(process.env.SCENARIOS ?? 40);
  await mkdir(join(ROOT, 'data'), { recursive: true });
  const cases = await loadGrownCases();
  const log: unknown[] = [];
  const logPath = join(ROOT, '.runs/grow-log.json');
  try {
    log.push(...(JSON.parse(await readFile(logPath, 'utf8')) as unknown[]));
  } catch {
    /* first run */
  }
  const count = (smell: string, control: boolean) =>
    cases.filter(c => c.smell === smell && Boolean(c.control) === control).length;
  let drafted = 0;
  const failures = new Map<string, number>();
  while (cases.length < target && drafted < maxScenarios) {
    // Draft for the smell with the fewest proven regressions, so the corpus stays balanced across categories; a smell
    // that keeps failing to prove anything is set aside after three tries rather than eating the whole budget.
    const smell = [...SMELLS]
      .filter(s => (failures.get(s.id) ?? 0) < 3)
      .sort((a, b) => count(a.id, false) - count(b.id, false))[0];
    if (!smell) break;
    drafted++;
    const taken = [...new Set(cases.map(c => c.grown!.scenario))];
    let result;
    try {
      const { scenario, model } = await draftScenario(smell, taken);
      if (taken.includes(scenario.id)) throw new Error(`scenario id ${scenario.id} already exists`);
      result = { scenario: scenario.id, smell: smell.id, model, ...(await proveScenario(scenario, model)) };
    } catch (error) {
      failures.set(smell.id, (failures.get(smell.id) ?? 0) + 1);
      console.log(`draft ${drafted} (${smell.id}): ${(error as Error).message}`);
      log.push({ at: new Date().toISOString(), smell: smell.id, error: (error as Error).message });
      await atomicJSON(logPath, log);
      continue;
    }
    if (result.kept.filter(c => !c.control).length === 0) failures.set(smell.id, (failures.get(smell.id) ?? 0) + 1);
    cases.push(...result.kept);
    await atomicJSON(GROWN_PATH, cases);
    log.push({ at: new Date().toISOString(), ...result, kept: result.kept.map(c => c.id) });
    await atomicJSON(logPath, log);
    console.log(
      `draft ${drafted} ${result.scenario} (${smell.id}): kept ${result.kept.length} (${result.kept.filter(c => !c.control).length} regressions, ${result.kept.filter(c => c.control).length} controls)${result.dropped.length ? `; dropped ${result.dropped.map(d => `${d.id}: ${d.why}`).join(' | ')}` : ''}`,
    );
  }
  const regressions = cases.filter(c => !c.control).length;
  console.log(
    `\n${cases.length} proven cases in ${GROWN_PATH} (${regressions} regressions, ${cases.length - regressions} controls):`,
  );
  for (const smell of SMELLS)
    console.log(`  ${smell.id.padEnd(16)} ${count(smell.id, false)} regressions, ${count(smell.id, true)} controls`);
}

/**
 * Code becomes an odor. Jev is the nose: thirty descriptive receptors, each a neutral yes/no property of the change,
 * each mapped to one olfactory glomerulus. The remaining glomeruli are lexical receptors driven by the identifiers and
 * operators in the changed lines, hashed. Nothing here says good or bad. The mushroom body learns that from what the
 * tests do afterwards.
 *
 * Which receptor lands on which glomerulus is arbitrary and fixed; only the pattern matters to the Kenyon cells.
 */
export const GLOMERULI = [
  'ORN_D',
  'ORN_DA1',
  'ORN_DA2',
  'ORN_DA3',
  'ORN_DA4l',
  'ORN_DA4m',
  'ORN_DC1',
  'ORN_DC2',
  'ORN_DC3',
  'ORN_DC4',
  'ORN_DL1',
  'ORN_DL2d',
  'ORN_DL2v',
  'ORN_DL3',
  'ORN_DL4',
  'ORN_DL5',
  'ORN_DM1',
  'ORN_DM2',
  'ORN_DM3',
  'ORN_DM4',
  'ORN_DM5',
  'ORN_DM6',
  'ORN_DP1l',
  'ORN_DP1m',
  'ORN_V',
  'ORN_VA1d',
  'ORN_VA1v',
  'ORN_VA2',
  'ORN_VA3',
  'ORN_VA4',
  'ORN_VA5',
  'ORN_VA6',
  'ORN_VA7l',
  'ORN_VA7m',
  'ORN_VC1',
  'ORN_VC2',
  'ORN_VC3',
  'ORN_VC4',
  'ORN_VC5',
  'ORN_VL1',
  'ORN_VL2a',
  'ORN_VL2p',
  'ORN_VM1',
  'ORN_VM2',
  'ORN_VM3',
  'ORN_VM4',
  'ORN_VM5d',
  'ORN_VM5v',
  'ORN_VM6l',
  'ORN_VM6m',
  'ORN_VM6v',
  'ORN_VM7d',
  'ORN_VM7v',
] as const;
export type Glomerulus = (typeof GLOMERULI)[number];

/** Descriptive receptors. Each question is about what changed, never about whether the change is good. */
export const RECEPTORS = [
  {
    key: 'removesConditional',
    label: 'Removes a conditional',
    question: 'Does the change remove or bypass a conditional check that the original code performed?',
  },
  {
    key: 'addsConditional',
    label: 'Adds a conditional',
    question: 'Does the change add a conditional check that the original did not perform?',
  },
  {
    key: 'changesComparison',
    label: 'Changes a comparison',
    question: 'Does the change alter a comparison operator or boundary, such as >= to > or < to <=?',
  },
  {
    key: 'changesBooleanLogic',
    label: 'Changes boolean logic',
    question: 'Does the change alter boolean logic (&&, ||, !) inside a condition?',
  },
  {
    key: 'constantReturn',
    label: 'Returns a constant',
    question:
      'Does the change make a function return a constant or fixed value regardless of its inputs where it previously depended on them?',
  },
  {
    key: 'changesArithmetic',
    label: 'Changes arithmetic',
    question: 'Does the change alter arithmetic, rounding, truncation, or the order of numeric operations?',
  },
  {
    key: 'changesLiteral',
    label: 'Changes a literal',
    question: 'Does the change alter a numeric or string literal value?',
  },
  {
    key: 'interpolatesParameter',
    label: 'Interpolates a parameter',
    question:
      'Does the change concatenate or interpolate a parameter or variable into a string where the original did not?',
  },
  {
    key: 'touchesLogging',
    label: 'Touches logging',
    question: 'Does the change add or alter logging, printing, or audit output?',
  },
  {
    key: 'touchesCredentials',
    label: 'Touches credentials',
    question: 'Does the change reference secrets, API keys, tokens, passwords, or other credentials?',
  },
  {
    key: 'touchesTiming',
    label: 'Touches timing',
    question: 'Does the change reference timers, delays, retries, backoff, timeouts, or expiry times?',
  },
  {
    key: 'touchesAsync',
    label: 'Touches async or ordering',
    question: 'Does the change involve asynchronous code, promises, callbacks, request identifiers, or event ordering?',
  },
  {
    key: 'touchesPersistence',
    label: 'Touches persistence',
    question: 'Does the change or its caller context involve databases, files, stored records, or deletion of records?',
  },
  {
    key: 'touchesPermissions',
    label: 'Touches permissions',
    question: 'Does the change reference permissions, approvals, roles, authorization, or tool gating?',
  },
  {
    key: 'touchesNetwork',
    label: 'Touches the network',
    question: 'Does the change or its caller context involve HTTP requests, network calls, or external APIs?',
  },
  {
    key: 'renameOnly',
    label: 'Renames only',
    question: 'Does the change rename identifiers without altering structure or computation?',
  },
  {
    key: 'restructuresOnly',
    label: 'Restructures only',
    question:
      'Does the change restructure code, such as extracting or renaming a variable, without altering the computed result for any input?',
  },
  {
    key: 'touchesComments',
    label: 'Touches comments',
    question: 'Does the change add, remove, or modify comments or documentation?',
  },
  { key: 'removesLogic', label: 'Removes logic', question: 'Does the change delete more logic than it adds?' },
  { key: 'addsLogic', label: 'Adds logic', question: 'Does the change add substantially more logic than it removes?' },
  {
    key: 'changesSignature',
    label: 'Changes a signature',
    question: 'Does the change alter a function signature, parameter list, or parameter types?',
  },
  {
    key: 'changesReturnShape',
    label: 'Changes the return shape',
    question: 'Does the change alter the type or shape of a returned value?',
  },
  { key: 'touchesTests', label: 'Touches tests', question: 'Does the change add, remove, or modify automated tests?' },
  {
    key: 'touchesErrorHandling',
    label: 'Touches error handling',
    question: 'Does the change add, remove, or alter error handling, input validation, or thrown errors?',
  },
  {
    key: 'touchesLoop',
    label: 'Touches a loop',
    question: 'Does the change add, remove, or alter a loop or iteration?',
  },
  {
    key: 'processesExternalInput',
    label: 'Processes external input',
    question:
      'Does the changed code process data that comes from a user, a request, or an external caller, based on the caller context?',
  },
  {
    key: 'changesDefault',
    label: 'Changes a default',
    question: 'Does the change alter a default value, fallback, or cap?',
  },
  {
    key: 'commentJustifies',
    label: 'Comment justifies behavior',
    question: 'Does the change include a comment that asserts or justifies the new behavior?',
  },
  { key: 'spansFiles', label: 'Spans files', question: 'Does the change span multiple files or modules?' },
  {
    key: 'touchesConfig',
    label: 'Touches configuration',
    question: 'Does the change alter configuration, environment variables, dependencies, or build settings?',
  },
] as const;
export type ReceptorKey = (typeof RECEPTORS)[number]['key'];
export const RECEPTOR_KEYS = RECEPTORS.map(r => r.key) as ReceptorKey[];
export type Descriptors = Record<ReceptorKey, number>;
/** Receptor i sits on glomerulus i; the rest of the glomeruli are lexical. */
export const RECEPTOR_GLOMERULUS = Object.fromEntries(RECEPTORS.map((r, i) => [r.key, GLOMERULI[i]])) as Record<
  ReceptorKey,
  Glomerulus
>;
export const LEXICAL_GLOMERULI = GLOMERULI.slice(RECEPTORS.length) as Glomerulus[];
/** Sparse odor: a descriptor has to be at least this likely to reach the antenna. */
export const RECEPTOR_FLOOR = 0.25;
export const RECEPTOR_MAX_HZ = 150;
export const LEXICAL_MAX_HZ = 120;

/** An odor is a set of glomerulus rates, written in the form the bridge accepts. */
export type Odor = Record<string, number>;
export const odorKey = (g: Glomerulus) => `odor:${g}`;

export function parseDescriptors(value: unknown): Descriptors {
  if (!value || typeof value !== 'object') throw new Error(`Expected ${RECEPTOR_KEYS.length} descriptor probabilities`);
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).length !== RECEPTOR_KEYS.length ||
    RECEPTOR_KEYS.some(
      k => typeof d[k] !== 'number' || !Number.isFinite(d[k] as number) || (d[k] as number) < 0 || (d[k] as number) > 1,
    )
  )
    throw new Error('Descriptors must be probabilities between zero and one');
  return Object.fromEntries(RECEPTOR_KEYS.map(k => [k, d[k] as number])) as Descriptors;
}

/** Identifiers, keywords, operators, and literals from the changed lines only. */
export function tokenize(changedText: string): string[] {
  return (
    changedText.match(
      /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|==|!=|>=|<=|&&|\|\||\*\*|=>|\?\?|[+\-*/%<>!?:;,.(){}[\]=|&]/g,
    ) ?? []
  );
}
/** FNV-1a, so the same token always lands on the same lexical glomerulus. */
export function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
/** Background the nose adapts to: keywords, types, and punctuation that appear in nearly every TypeScript change. */
export const STOP_TOKENS = new Set([
  'export',
  'function',
  'return',
  'const',
  'let',
  'var',
  'if',
  'else',
  'number',
  'string',
  'boolean',
  'void',
  'true',
  'false',
  'null',
  'undefined',
  'import',
  'from',
  'type',
  'interface',
  'class',
  'new',
  'this',
  'async',
  'await',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ':',
  ';',
  ',',
  '.',
  '=',
  '=>',
]);
export function lexicalOdor(tokens: string[]): Odor {
  const counts = new Map<Glomerulus, number>();
  for (const token of tokens) {
    if (STOP_TOKENS.has(token)) continue;
    const g = LEXICAL_GLOMERULI[hashToken(token) % LEXICAL_GLOMERULI.length];
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const odor: Odor = {};
  for (const [g, n] of counts)
    odor[odorKey(g)] = Math.round(Math.min(LEXICAL_MAX_HZ, 35 * Math.log2(1 + n)) * 100) / 100;
  return odor;
}
export function descriptorOdor(descriptors: Descriptors): Odor {
  const odor: Odor = {};
  for (const r of RECEPTORS) {
    const p = descriptors[r.key];
    if (p >= RECEPTOR_FLOOR) odor[odorKey(RECEPTOR_GLOMERULUS[r.key])] = Math.round(p * RECEPTOR_MAX_HZ * 100) / 100;
  }
  return odor;
}
/**
 * Receptors whose question is a verdict in disguise: answering them means judging whether behavior changed, which is the
 * label the tests produce. A nose may say what changed; it may not say whether that changed the result.
 */
export const VERDICT_RECEPTORS: readonly ReceptorKey[] = ['restructuresOnly', 'renameOnly'];
/** full: all thirty receptors. neutral: without the verdict receptors. lexical: no Jev at all, tokens only. */
export const NOSES = ['full', 'neutral', 'lexical'] as const;
export type Nose = (typeof NOSES)[number];
export const LIVE_NOSE: Nose = 'neutral';
export function parseNose(value: string | undefined): Nose {
  const nose = (value ?? LIVE_NOSE) as Nose;
  if (!NOSES.includes(nose)) throw new Error(`NOSE must be one of ${NOSES.join(', ')}`);
  return nose;
}
/** What of Jev's description reaches the antenna through a nose: verdict receptors are silent unless the nose is full. */
export function hear(descriptors: Descriptors, nose: Nose = LIVE_NOSE): Descriptors {
  if (nose === 'full') return descriptors;
  const silent = nose === 'lexical' ? RECEPTOR_KEYS : VERDICT_RECEPTORS;
  return { ...descriptors, ...Object.fromEntries(silent.map(k => [k, 0])) };
}
/** The whole smell of a change: what Jev noticed plus what the tokens are. */
export function odorize(descriptors: Descriptors, changedText: string, nose: Nose = LIVE_NOSE): Odor {
  return { ...descriptorOdor(hear(descriptors, nose)), ...lexicalOdor(tokenize(changedText)) };
}
/** Which glomerulus a receptor or token drives, for the display. */
export function odorEntries(odor: Odor): { glomerulus: Glomerulus; hz: number; receptor: ReceptorKey | null }[] {
  return GLOMERULI.map((g, i) => ({
    glomerulus: g,
    hz: odor[odorKey(g)] ?? 0,
    receptor: i < RECEPTORS.length ? RECEPTORS[i].key : null,
  }));
}

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { atomicJSON, ROOT } from './io.ts';
import type { Mined, ReviewCase } from './review-cases.ts';
import { MINED_DIR, validateMinedCase } from './review-mined.ts';

/**
 * Mine a real TypeScript repository for changes whose labels its own test suite proves.
 *
 *   npm run mutate:repo -- owner/repo            clone, install, run the suite, run Stryker, extract cases
 *   REF=<sha>                                    pin a commit (default: the default branch head)
 *   PER_FUNCTION=3 CONTROLS_PER_FUNCTION=2       how many killed mutants and verified rewrites to keep per function
 *   MAX_CHARS=6000                               skip functions longer than this (the diff shown to the nose)
 *   CONCURRENCY=6 TIMEOUT_MS=15000               Stryker settings
 *   SKIP_STRYKER=1                               reuse an existing reports/mutation/mutation.json
 *   NO_TSCHECK=1                                 skip Stryker's TypeScript checker (mutants that do not compile are then kept)
 *
 * Bitter: every mutant Stryker reports as Killed is a change that made a real test fail. Sugar: mechanical rewrites of
 * the same functions (rename a local, flip an if/else, invert an equality, swap a comparison's operands) that the whole
 * suite and the type check pass with. Survived and uncovered mutants teach nothing: a mutant the tests missed is not a
 * safe change, it is an unknown one. The repository's tests are the only judge; nothing here reads the code for bugs.
 *
 * The clone runs the repository's install and tests on this machine. Only mine repositories you would run locally.
 */
const [ref] = process.argv.slice(2);
if (!ref || !/^[\w.-]+\/[\w.-]+$/.test(ref)) throw new Error('Usage: npm run mutate:repo -- owner/repo');
const [owner, repo] = ref.split('/');
const perFunction = Number(process.env.PER_FUNCTION ?? 3);
const controlsPerFunction = Number(process.env.CONTROLS_PER_FUNCTION ?? 2);
const maxChars = Number(process.env.MAX_CHARS ?? 6000);
const concurrency = Number(process.env.CONCURRENCY ?? 6);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 15_000);
const dir = join(ROOT, '.runs/repos', `${owner}-${repo}`);
const reportPath = join(dir, 'reports/mutation/mutation.json');
await mkdir(join(ROOT, '.runs/repos'), { recursive: true });

const run = (file: string, args: string[], cwd = dir, timeout = 600_000): Promise<{ out: string; ok: boolean }> =>
  new Promise(resolve => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64_000_000,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      // Terminal styling is stripped so the summary lines can be read.
      (error, stdout, stderr) => resolve({ out: `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/g, ''), ok: !error }),
    );
  });
const must = async (file: string, args: string[], what: string, cwd = dir, timeout = 600_000) => {
  const r = await run(file, args, cwd, timeout);
  if (!r.ok) throw new Error(`${what} failed:\n${r.out.slice(-3000)}`);
  return r.out;
};
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// 1. The repository, at one commit.
if (!(await exists(join(dir, '.git')))) {
  console.log(`cloning ${ref}`);
  await must(
    'git',
    ['clone', '--quiet', ...(process.env.REF ? [] : ['--depth', '1']), `https://github.com/${owner}/${repo}.git`, dir],
    'git clone',
    ROOT,
  );
}
if (process.env.REF) await must('git', ['checkout', '--quiet', process.env.REF], 'git checkout');
const commit = (await must('git', ['rev-parse', 'HEAD'], 'git rev-parse')).trim();
const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
  packageManager?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const dev = { ...pkg.dependencies, ...pkg.devDependencies };
const pm = pkg.packageManager?.startsWith('pnpm')
  ? 'pnpm'
  : pkg.packageManager?.startsWith('yarn')
    ? 'yarn'
    : (await exists(join(dir, 'pnpm-lock.yaml')))
      ? 'pnpm'
      : (await exists(join(dir, 'yarn.lock')))
        ? 'yarn'
        : 'npm';
const runner = dev.vitest ? 'vitest' : dev.jest ? 'jest' : dev.mocha ? 'mocha' : null;
if (!runner) throw new Error(`${ref}: no vitest, jest, or mocha in its dependencies; Stryker has no runner for it`);
const exec = (args: string[], timeout?: number) =>
  run(pm, [pm === 'npm' ? 'exec' : 'exec', ...(pm === 'npm' ? ['--'] : []), ...args], dir, timeout);
console.log(`${ref} @ ${commit.slice(0, 7)}: ${pm}, ${runner}`);

// 2. Install and a green baseline. Scripts are not run on install; the tests are run as the repository runs them.
const installArgs =
  pm === 'pnpm'
    ? ['install', '--frozen-lockfile', '--ignore-scripts']
    : pm === 'yarn'
      ? ['install', '--frozen-lockfile', '--ignore-scripts']
      : ['ci', '--ignore-scripts'];
if (!(await exists(join(dir, 'node_modules')))) {
  console.log('installing');
  await must(pm, installArgs, `${pm} install`);
}
// The runner is invoked directly rather than through the test script, which often chains lint or coverage gates that
// have nothing to do with whether the tests pass.
const runSuite = () =>
  exec(runner === 'vitest' ? ['vitest', 'run'] : runner === 'jest' ? ['jest', '--ci'] : ['mocha'], 600_000);
const countTests = (out: string): number | null => {
  const m =
    out.match(/Tests\s+(\d+) passed/) ?? // vitest
    out.match(/Tests:\s+(\d+) passed/) ?? // jest
    out.match(/(\d+) passing/); // mocha
  return m ? Number(m[1]) : null;
};
console.log('baseline test run');
const baseline = await runSuite();
const baselineCount = countTests(baseline.out);
if (!baseline.ok || !baselineCount)
  throw new Error(
    `The suite does not pass at ${commit.slice(0, 7)}; a red baseline would kill every mutant.\n${baseline.out.slice(-2000)}`,
  );
const baselineTests: number = baselineCount;
console.log(`baseline: ${baselineTests} tests pass`);
// Rewrites must type-check as well as pass: the repository's own script if it has one, else tsc on its tsconfig.
const typecheckScript = pkg.scripts?.typecheck ? ['run', 'typecheck'] : null;
const typecheck = async (): Promise<boolean> =>
  typecheckScript ? (await run(pm, typecheckScript)).ok : (await exec(['tsc', '--noEmit', '-p', 'tsconfig.json'])).ok;
if (!(await typecheck())) throw new Error(`The type check does not pass at ${commit.slice(0, 7)}.`);

// 3. Stryker, with the repository's own runner, one process per mutant batch, per-test coverage.
if (!process.env.SKIP_STRYKER || !(await exists(reportPath))) {
  const plugins = [
    `@stryker-mutator/${runner}-runner`,
    ...(process.env.NO_TSCHECK ? [] : ['@stryker-mutator/typescript-checker']),
  ];
  if (!(await exists(join(dir, 'node_modules/@stryker-mutator/core')))) {
    console.log('installing stryker');
    const addArgs =
      pm === 'pnpm'
        ? ['add', ...((await exists(join(dir, 'pnpm-workspace.yaml'))) ? ['-w'] : []), '-D', '--ignore-scripts']
        : pm === 'yarn'
          ? ['add', '-D', '--ignore-scripts']
          : ['install', '-D', '--no-save', '--ignore-scripts'];
    await must(pm, [...addArgs, '@stryker-mutator/core@10', ...plugins.map(p => `${p}@10`)], 'installing stryker');
  }
  const tsconfig = (await exists(join(dir, 'tsconfig.app.json'))) ? 'tsconfig.app.json' : 'tsconfig.json';
  // Stryker's jest plugin wraps the test environment with a plain require, which cannot load a TypeScript environment
  // or expand <rootDir>. When the repository uses one, transpile it once and hand Stryker a config that points at the
  // compiled copy by absolute path.
  let jestOverride: Record<string, unknown> = {};
  if (runner === 'jest') {
    for (const f of ['jest.config.js', 'jest.config.cjs']) {
      if (!(await exists(join(dir, f)))) continue;
      const { createRequire } = await import('node:module');
      const loaded = createRequire(join(dir, 'package.json'))(join(dir, f)) as { testEnvironment?: string };
      const env = loaded.testEnvironment;
      if (env && /\.ts$/.test(env)) {
        const source = await readFile(join(dir, env.replace('<rootDir>', '.')), 'utf8');
        const js = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText;
        await writeFile(join(dir, '.stryker-jest-environment.cjs'), js);
        await writeFile(
          join(dir, '.stryker-jest.config.cjs'),
          `module.exports = { ...require('./${f}'), testEnvironment: ${JSON.stringify(join(dir, '.stryker-jest-environment.cjs'))} };\n`,
        );
        jestOverride = { jest: { configFile: '.stryker-jest.config.cjs' } };
      }
      break;
    }
  }
  const config = {
    testRunner: runner,
    plugins,
    coverageAnalysis: 'perTest',
    mutate: [
      'src/**/*.ts',
      '!src/**/*.spec.ts',
      '!src/**/*.test.ts',
      '!src/**/__tests__/**',
      '!src/**/__mocks__/**',
      '!src/**/test-helpers.ts',
      '!src/**/*.d.ts',
    ],
    ...(process.env.NO_TSCHECK ? {} : { checkers: ['typescript'], tsconfigFile: tsconfig }),
    // Jest configs resolve custom environments and transforms against the real root, so mutate in place (Stryker
    // restores the files; the rewrite step below also restores from git).
    ...(runner === 'jest' ? { inPlace: true, ...jestOverride } : {}),
    reporters: ['json', 'progress-append-only'],
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    timeoutMS: timeoutMs,
    concurrency,
    ignoreStatic: true,
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
    warnings: { unknownOptions: false, slow: false },
  };
  await writeFile(join(dir, 'stryker.config.json'), JSON.stringify(config, null, 2));
  console.log('running stryker (this is the long part)');
  const started = Date.now();
  const stryker = await exec(['stryker', 'run'], 4 * 3_600_000);
  if (!stryker.ok || !(await exists(reportPath))) throw new Error(`stryker failed:\n${stryker.out.slice(-4000)}`);
  console.log(
    stryker.out
      .split('\n')
      .filter(l => /Instrumented|Done in|Killed|Survived/.test(l))
      .join('\n')
      .slice(-800),
  );
  console.log(`stryker: ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

// 4. The report: every mutant with its status, location, replacement, and the tests that killed it.
type Position = { line: number; column: number };
type Mutant = {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  statusReason?: string;
  killedBy?: string[];
  coveredBy?: string[];
  location: { start: Position; end: Position };
};
type Report = {
  files: Record<string, { source: string; mutants: Mutant[] }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>;
};
const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
const testNames = new Map<string, string>();
for (const file of Object.values(report.testFiles ?? {})) for (const t of file.tests) testNames.set(t.id, t.name);

/** A function-sized unit of a file: the outermost declaration the change sits in, or the innermost one that fits the cap. */
type Unit = { node: ts.Node; name: string; start: number; end: number };
const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ((ts.isVariableStatement(n) || ts.isPropertyDeclaration(n)) &&
    (ts.isVariableStatement(n) ? n.declarationList.declarations : [n]).some(
      d => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)),
    ));
const nameOf = (n: ts.Node): string | null => {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n))
    return n.name && ts.isIdentifier(n.name) ? n.name.text : null;
  if (ts.isVariableStatement(n)) {
    const d = n.declarationList.declarations.find(
      d => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)),
    );
    return d && ts.isIdentifier(d.name) ? d.name.text : null;
  }
  return null;
};
function unitFor(sf: ts.SourceFile, start: number, end: number): Unit | null {
  const chain: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (n.getStart(sf) <= start && end <= n.getEnd()) {
      if (isFunctionLike(n)) chain.push(n);
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  // Outermost first; the first that fits the cap is the unit. Nested callbacks only if the whole function is too long.
  for (const n of chain) {
    const s = n.getStart(sf),
      e = n.getEnd();
    const name = nameOf(n);
    if (name && e - s <= maxChars && e - s >= 60) return { node: n, name, start: s, end: e };
  }
  return null;
}
const offsetOf = (sf: ts.SourceFile, p: Position) => sf.getPositionOfLineAndCharacter(p.line - 1, p.column - 1);
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const leadingDoc = (sf: ts.SourceFile, node: ts.Node): string => {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  return ranges
    .map(r => sf.text.slice(r.pos, r.end))
    .join('\n')
    .replace(/^\s*\/\*\*?|\*\/\s*$|^\s*\* ?/gm, '')
    .trim();
};
const shorten = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const at = new Date().toISOString();
const cases: ReviewCase[] = [];
const contextFor = (sf: ts.SourceFile, file: string, unit: Unit) => {
  const doc = leadingDoc(sf, unit.node);
  return `${ref}, ${file}${doc ? `. ${shorten(doc.replace(/\s+/g, ' '), 400)}` : ''}`;
};

// 4a. Bitter: killed mutants, a few per function, spread across mutation kinds.
const families = new Map<string, { file: string; sf: ts.SourceFile; unit: Unit; mutants: Mutant[] }>();
let killed = 0,
  unplaced = 0,
  tooLong = 0;
for (const [file, data] of Object.entries(report.files)) {
  // Test helpers that live under src/ are not the library.
  if (/test-helper|__mocks__|fixtures?\//.test(file)) continue;
  const sf = ts.createSourceFile(file, data.source, ts.ScriptTarget.Latest, true);
  for (const m of data.mutants) {
    if (m.status !== 'Killed' || !m.killedBy?.length || typeof m.replacement !== 'string') continue;
    killed++;
    const s = offsetOf(sf, m.location.start),
      e = offsetOf(sf, m.location.end);
    const unit = unitFor(sf, s, e);
    if (!unit) {
      unplaced++;
      continue;
    }
    const key = `${file}:${unit.name}`;
    const family = families.get(key) ?? { file, sf, unit, mutants: [] };
    family.mutants.push(m);
    families.set(key, family);
  }
}
for (const [key, family] of families) {
  const { file, sf, unit } = family;
  const byMutator = new Map<string, Mutant[]>();
  for (const m of family.mutants) byMutator.set(m.mutatorName, [...(byMutator.get(m.mutatorName) ?? []), m]);
  const chosen: Mutant[] = [];
  const kinds = [...byMutator.keys()].sort();
  // A body emptied to {} is a mutant no reviewer would ever see; take it last.
  kinds.sort((a, b) => Number(a === 'BlockStatement') - Number(b === 'BlockStatement'));
  for (let round = 0; chosen.length < perFunction; round++) {
    let took = false;
    for (const kind of kinds) {
      const m = byMutator.get(kind)![round];
      if (m && chosen.length < perFunction) {
        chosen.push(m);
        took = true;
      }
    }
    if (!took) break;
  }
  for (const m of chosen) {
    const s = offsetOf(sf, m.location.start),
      e = offsetOf(sf, m.location.end);
    const before = sf.text.slice(unit.start, unit.end);
    const after = sf.text.slice(unit.start, s) + m.replacement + sf.text.slice(e, unit.end);
    if (after.length > maxChars) {
      tooLong++;
      continue;
    }
    const original = sf.text.slice(s, e).replace(/\s+/g, ' ');
    const mined: Mined = {
      repo: ref,
      commit,
      file,
      family: key,
      kind: 'mutant',
      mutator: m.mutatorName,
      killedBy: m.killedBy!.map(id => testNames.get(id) ?? id).slice(0, 8),
      statusReason: m.statusReason?.slice(0, 200),
      at,
    };
    cases.push({
      id: kebab(`${owner}-${repo}-${file.replace(/\.ts$/, '')}-${unit.name}-m${m.id}`),
      title: `${unit.name}: ${shorten(original, 36)} → ${shorten(m.replacement!.replace(/\s+/g, ' ') || '(removed)', 24)}`,
      group: ref,
      filename: file,
      context: contextFor(sf, file, unit),
      before,
      after,
      functionName: unit.name,
      contract: null,
      parameters: [],
      oracle: null,
      format: 'text',
      mined,
    });
  }
}
const mutantCases = cases.length;
console.log(
  `${killed} killed mutants in ${families.size} functions; kept ${mutantCases} (${unplaced} outside any function, ${tooLong} too long)`,
);

// 4b. Sugar: mechanical rewrites of the same functions, verified by the whole suite and the type check.
type Edit = { start: number; end: number; text: string };
type Rewrite = { kind: string; title: string; edits: Edit[] };
const RENAMES: Record<string, string> = {
  res: 'response',
  req: 'request',
  err: 'error',
  e: 'error',
  opts: 'options',
  cfg: 'config',
  ctx: 'context',
  idx: 'index',
  i: 'index',
  val: 'value',
  fn: 'callback',
  cb: 'callback',
  msg: 'message',
  params: 'parameters',
  args: 'arguments_',
  str: 'text',
  num: 'count',
  arr: 'items',
  obj: 'record',
  el: 'element',
  evt: 'event',
  tmp: 'temporary',
  acc: 'accumulator',
  prev: 'previous',
  cur: 'current',
  len: 'length',
};
function renameLocal(sf: ts.SourceFile, checker: ts.TypeChecker, unit: Unit): Rewrite | null {
  const declarations: { name: ts.Identifier; symbol: ts.Symbol }[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && ts.isIdentifier(n.name)) {
      const symbol = checker.getSymbolAtLocation(n.name);
      if (symbol) declarations.push({ name: n.name, symbol });
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.node);
  const taken = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isIdentifier(n)) taken.add(n.text);
    ts.forEachChild(n, collect);
  };
  collect(unit.node);
  for (const { name, symbol } of declarations) {
    if (name.text.length < 1 || name.text.startsWith('_')) continue;
    const newName = RENAMES[name.text] ?? (name.text.endsWith('Value') ? `${name.text}Item` : `${name.text}Value`);
    if (taken.has(newName)) continue;
    const refs: ts.Identifier[] = [];
    let unsafe = false;
    const find = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === name.text) {
        const s = checker.getSymbolAtLocation(n);
        if (s === symbol) {
          const p = n.parent;
          // Shorthand properties and destructuring would change a key; property accesses are a different symbol anyway.
          if (ts.isShorthandPropertyAssignment(p) || ts.isBindingElement(p)) unsafe = true;
          refs.push(n);
        }
      }
      ts.forEachChild(n, find);
    };
    find(unit.node);
    if (unsafe || refs.length < 2) continue;
    return {
      kind: 'rename-local',
      title: `${unit.name}: rename ${name.text} to ${newName}`,
      edits: refs.map(r => ({ start: r.getStart(sf), end: r.getEnd(), text: newName })),
    };
  }
  return null;
}
function flipIfElse(sf: ts.SourceFile, unit: Unit): Rewrite | null {
  let found: Rewrite | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isIfStatement(n) &&
      n.elseStatement &&
      !ts.isIfStatement(n.elseStatement) &&
      ts.isBlock(n.thenStatement) &&
      ts.isBlock(n.elseStatement)
    ) {
      const c = n.expression;
      let negated: string;
      if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken)
        negated = c.operand.getText(sf);
      else if (
        ts.isBinaryExpression(c) &&
        (c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      )
        negated = `${c.left.getText(sf)} ${c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? '!==' : '==='} ${c.right.getText(sf)}`;
      else negated = `!(${c.getText(sf)})`;
      found = {
        kind: 'flip-if-else',
        title: `${unit.name}: flip an if/else`,
        edits: [
          { start: c.getStart(sf), end: c.getEnd(), text: negated },
          { start: n.thenStatement.getStart(sf), end: n.thenStatement.getEnd(), text: n.elseStatement.getText(sf) },
          { start: n.elseStatement.getStart(sf), end: n.elseStatement.getEnd(), text: n.thenStatement.getText(sf) },
        ],
      };
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.node);
  return found;
}
function invertEquality(sf: ts.SourceFile, unit: Unit): Rewrite | null {
  let found: Rewrite | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      !ts.isPrefixUnaryExpression(n.parent)
    ) {
      const op = n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? '!==' : '===';
      found = {
        kind: 'invert-equality',
        title: `${unit.name}: rewrite ${n.operatorToken.getText(sf)} as a negated ${op}`,
        edits: [
          { start: n.getStart(sf), end: n.getEnd(), text: `!(${n.left.getText(sf)} ${op} ${n.right.getText(sf)})` },
        ],
      };
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.node);
  return found;
}
function swapComparison(sf: ts.SourceFile, unit: Unit): Rewrite | null {
  const swap: Partial<Record<ts.SyntaxKind, string>> = {
    [ts.SyntaxKind.LessThanToken]: '>',
    [ts.SyntaxKind.GreaterThanToken]: '<',
    [ts.SyntaxKind.LessThanEqualsToken]: '>=',
    [ts.SyntaxKind.GreaterThanEqualsToken]: '<=',
  };
  const pure = (e: ts.Expression) =>
    ts.isIdentifier(e) || ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isPropertyAccessExpression(e);
  let found: Rewrite | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && swap[n.operatorToken.kind] && pure(n.left) && pure(n.right)) {
      found = {
        kind: 'swap-comparison',
        title: `${unit.name}: write ${n.operatorToken.getText(sf)} the other way round`,
        edits: [
          {
            start: n.getStart(sf),
            end: n.getEnd(),
            text: `${n.right.getText(sf)} ${swap[n.operatorToken.kind]} ${n.left.getText(sf)}`,
          },
        ],
      };
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.node);
  return found;
}
const applyEdits = (text: string, edits: Edit[]) => {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
};

type Candidate = { key: string; file: string; unit: Unit; rewrite: Rewrite; before: string; after: string };
const candidates: Candidate[] = [];
const programs = new Map<string, { program: ts.Program; sf: ts.SourceFile }>();
for (const [key, family] of families) {
  const { file, unit } = family;
  let entry = programs.get(file);
  if (!entry) {
    const program = ts.createProgram([join(dir, file)], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      noResolve: true,
      allowJs: false,
    });
    entry = { program, sf: program.getSourceFile(join(dir, file))! };
    programs.set(file, entry);
  }
  const { program, sf } = entry;
  const checker = program.getTypeChecker();
  // Re-find the unit in the program's source file (same text, different tree).
  const u = unitFor(sf, unit.start, unit.end);
  if (!u) continue;
  // Comparison rewrites first: they trip the same receptors a broken comparison does, so the nose cannot learn that
  // "touches a comparison" means bad. A rename is the fallback, and the corpus says how many controls are renames.
  const rewrites = [invertEquality(sf, u), flipIfElse(sf, u), swapComparison(sf, u), renameLocal(sf, checker, u)]
    .filter((r): r is Rewrite => r !== null)
    .slice(0, controlsPerFunction);
  for (const rewrite of rewrites) {
    const before = sf.text.slice(u.start, u.end);
    const after = applyEdits(sf.text, rewrite.edits).slice(
      u.start,
      u.end + rewrite.edits.reduce((d, e) => d + e.text.length - (e.end - e.start), 0),
    );
    if (after === before || after.length > maxChars) continue;
    candidates.push({ key, file, unit: u, rewrite, before, after });
  }
}
console.log(
  `${candidates.length} rewrite candidates in ${new Set(candidates.map(c => c.key)).size} functions; verifying against the suite`,
);

/** Apply a set of rewrites to the working tree, run the type check and the suite, restore. */
const originals = new Map<string, string>();
for (const file of new Set(candidates.map(c => c.file))) originals.set(file, await readFile(join(dir, file), 'utf8'));
let suiteRuns = 0;
async function passes(batch: Candidate[]): Promise<{ ok: boolean; tests: number; typecheck: boolean }> {
  const byFile = new Map<string, Edit[]>();
  for (const c of batch) byFile.set(c.file, [...(byFile.get(c.file) ?? []), ...c.rewrite.edits]);
  try {
    for (const [file, edits] of byFile) await writeFile(join(dir, file), applyEdits(originals.get(file)!, edits));
    suiteRuns++;
    const typed = await typecheck();
    if (!typed) return { ok: false, tests: 0, typecheck: typed };
    const t = await runSuite();
    const tests = countTests(t.out) ?? 0;
    return { ok: t.ok && tests >= baselineTests, tests, typecheck: typed };
  } finally {
    for (const [file, text] of originals) await writeFile(join(dir, file), text);
  }
}
const verified: { candidate: Candidate; tests: number }[] = [];
const rejected: Candidate[] = [];
async function verify(batch: Candidate[]): Promise<void> {
  if (batch.length === 0) return;
  // One rewrite per function per batch, so edits never overlap.
  const seen = new Set<string>();
  const now: Candidate[] = [],
    later: Candidate[] = [];
  for (const c of batch) (seen.has(c.key) ? later : now).push(c) && seen.add(c.key);
  const result = await passes(now);
  if (result.ok) for (const c of now) verified.push({ candidate: c, tests: result.tests });
  else if (now.length === 1) rejected.push(now[0]);
  else {
    const half = Math.ceil(now.length / 2);
    await verify(now.slice(0, half));
    await verify(now.slice(half));
  }
  await verify(later);
}
await verify(candidates);
await must('git', ['checkout', '--', 'src'], 'git checkout');
console.log(`${verified.length} rewrites verified, ${rejected.length} rejected, in ${suiteRuns} suite runs`);
for (const { candidate: c, tests } of verified) {
  const mined: Mined = {
    repo: ref,
    commit,
    file: c.file,
    family: c.key,
    kind: 'rewrite',
    rewrite: c.rewrite.kind,
    verified: { suite: runner, tests, typecheck: true },
    at,
  };
  cases.push({
    id: kebab(`${owner}-${repo}-${c.file.replace(/\.ts$/, '')}-${c.unit.name}-${c.rewrite.kind}`),
    title: c.rewrite.title,
    group: ref,
    filename: c.file,
    context: contextFor(programs.get(c.file)!.sf, c.file, c.unit),
    before: c.before,
    after: c.after,
    functionName: c.unit.name,
    contract: null,
    parameters: [],
    oracle: null,
    format: 'text',
    control: true,
    mined,
  });
}

// 5. Save, validated, one file per repository.
const ids = new Set<string>();
const kept = cases.filter(c => {
  if (ids.has(c.id)) return false;
  ids.add(c.id);
  return true;
});
kept.forEach(validateMinedCase);
await mkdir(MINED_DIR, { recursive: true });
const outPath = join(MINED_DIR, `${owner}-${repo}.json`);
await atomicJSON(outPath, kept);
const summary = {
  repo: ref,
  commit,
  at,
  runner,
  baselineTests,
  killed,
  functions: families.size,
  mutants: mutantCases,
  rewrites: verified.length,
  rewritesRejected: rejected.length,
  byMutator: Object.fromEntries(
    [...new Set(kept.filter(c => c.mined!.kind === 'mutant').map(c => c.mined!.mutator!))].map(m => [
      m,
      kept.filter(c => c.mined!.mutator === m).length,
    ]),
  ),
  byRewrite: Object.fromEntries(
    [...new Set(kept.filter(c => c.mined!.kind === 'rewrite').map(c => c.mined!.rewrite!))].map(r => [
      r,
      kept.filter(c => c.mined!.rewrite === r).length,
    ]),
  ),
  rejectedRewrites: rejected.map(c => c.rewrite.title),
};
await atomicJSON(join(MINED_DIR, `${owner}-${repo}.summary.json`), summary);
console.log(JSON.stringify(summary, null, 2));
console.log(`\n${kept.length} cases (${mutantCases} regressions, ${verified.length} controls) at ${outPath}`);

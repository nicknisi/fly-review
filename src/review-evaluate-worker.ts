import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import type { Scalar } from './review-cases.ts';

// A restricted, timed runner for the bundled functions, not a hostile-code sandbox.
const { before, after, functionName, inputs } = JSON.parse(readFileSync(0, 'utf8')) as { before: string; after: string; functionName: string; inputs: Scalar[][] };
if (typeof before !== 'string' || typeof after !== 'string' || typeof functionName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(functionName) || !Array.isArray(inputs) || inputs.length > 50 || inputs.some(args => !Array.isArray(args) || args.length > 3 || args.some(arg => !['number','string','boolean'].includes(typeof arg)))) throw new Error('Invalid probe');
const output = inputs.map(args => {
  const values = [before, after].map(source => {
    try {
      const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      runInContext('var exports = Object.create(null);\n' + source, context, { timeout: 100 });
      // JSON literals keep even quote-bearing string arguments out of executable syntax.
      const result: unknown = runInContext(`exports[${JSON.stringify(functionName)}](...${JSON.stringify(args)})`, context, { timeout: 100 });
      const valid = typeof result === 'boolean' || (typeof result === 'number' && Number.isFinite(result)) || (typeof result === 'string' && result.length <= 2000);
      return valid ? { value: result as Scalar } : { error: 'Not a supported finite scalar result' };
    } catch { return { error: 'Function threw, failed to compile, or exceeded its time limit' }; }
  });
  return { args, before: values[0], after: values[1] };
});
process.stdout.write(JSON.stringify(output));

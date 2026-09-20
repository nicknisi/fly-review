import { join } from 'node:path';
import { ROOT } from './io.ts';
import { MEMORY_PATH } from './review-brain.ts';
import { installMemory } from './review-memory.ts';

/**
 * Make a trained memory the live fly. Factors and lesson provenance move together under the memory lock; the previous
 * live memory is replaced, so run this before a session or after Forget everything, not during a review.
 *
 *   npm run memory:install                         installs .runs/trained-memory.json
 *   npm run memory:install -- .runs/other.json      installs another memory file
 */
const source = join(ROOT, process.argv[2] ?? '.runs/trained-memory.json');
const installed = await installMemory(source, MEMORY_PATH);
console.log(
  `Installed ${source} as the live fly: ${installed.edges.toLocaleString()} synapses, ${installed.lessons} lessons. Reload the page; a running server picks the memory up on its next smell.`,
);

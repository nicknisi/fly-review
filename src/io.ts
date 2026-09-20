import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Separate local labs and verification servers must not share mutable experiment data. */
export const RUNS_ROOT = resolve(ROOT, process.env.FLY_REVIEW_DATA_DIR || '.runs');
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function command(file: string, args: string[], input = '', timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer: 2_000_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {}); // An early child exit is reported by execFile's callback.
    child.stdin?.end(input);
  });
}

/** Atomically persist review evidence and configuration; never expose a partial JSON file. */
export async function atomicJSON(path: string, value: unknown, space = 2): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, space)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    // Persist the rename as well as the contents on supported POSIX systems.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

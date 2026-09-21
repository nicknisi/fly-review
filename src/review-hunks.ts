import type { PullRequest } from './review-github.ts';
import { parsePatch } from './review-cases.ts';
import type { DiffLine } from './review-cases.ts';

/**
 * A pull request is read hunk by hunk. Each hunk is one puff of odor: Jev describes the hunk (with the pull request's
 * title and description as context) and the hunk's changed lines drive the lexical receptors. The fly reads the puffs
 * in order, and what still smells new on the second reading is where it looks.
 */
export const HUNK_LIMITS = {
  /** At most this many puffs per review; past it, whole files become the units, largest first. */
  units: 32,
  /** Characters of patch text sent to Jev per unit. */
  patch: 6_000,
} as const;

export type ReviewUnit = {
  index: number;
  filename: string;
  /** Position of the hunk within its file's patch, or null when the unit is the whole file. */
  hunk: number | null;
  header: string;
  /** Unified-diff text of this unit, starting at its @@ header. */
  patch: string;
  /** Changed lines only, for the lexical receptors. */
  changed: string;
  additions: number;
  deletions: number;
  /** The unit's first and last diff-line offsets within the whole rendered pull request, for highlighting. */
  lines: { from: number; to: number };
};

/** Split every file's patch at its @@ headers, keeping the line offsets the diff view will render. */
export function splitHunks(pr: PullRequest): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  let offset = 0;
  for (const file of pr.files) {
    if (!file.patch) continue;
    const lines: DiffLine[] = parsePatch(file.patch);
    const raw = file.patch.split('\n');
    // Walk the raw patch alongside the parsed lines so each unit knows both its text and its rendered offsets.
    let current: { header: string; rawStart: number; lineStart: number; hunk: number } | null = null;
    let rawIndex = 0,
      lineIndex = 0,
      hunk = 0;
    const flush = (rawEnd: number, lineEnd: number) => {
      if (!current) return;
      const patch = raw.slice(current.rawStart, rawEnd).join('\n');
      const body = lines.slice(current.lineStart, lineEnd);
      units.push({
        index: units.length,
        filename: file.filename,
        hunk: current.hunk,
        header: current.header,
        patch,
        changed: body
          .filter(l => l.kind === 'added' || l.kind === 'removed')
          .map(l => l.text)
          .join('\n'),
        additions: body.filter(l => l.kind === 'added').length,
        deletions: body.filter(l => l.kind === 'removed').length,
        lines: { from: offset + current.lineStart, to: offset + lineEnd - 1 },
      });
    };
    for (; rawIndex < raw.length; rawIndex++) {
      const text = raw[rawIndex];
      if (text.startsWith('\\')) continue;
      // fly-review's own truncation marker is not a hunk; it ends the one before it.
      if (text.startsWith('@@ patch truncated')) {
        flush(rawIndex, lineIndex);
        current = null;
        lineIndex++;
        continue;
      }
      if (text.startsWith('@@')) {
        flush(rawIndex, lineIndex);
        current = { header: text, rawStart: rawIndex, lineStart: lineIndex, hunk: hunk++ };
      }
      lineIndex++;
    }
    flush(raw.length, lineIndex);
    offset += lines.length;
  }
  return units;
}

/** Whole files as units, for pull requests with too many hunks to smell one by one. Largest changes first. */
export function fileUnits(pr: PullRequest): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  let offset = 0;
  for (const file of pr.files) {
    if (!file.patch) continue;
    const lines = parsePatch(file.patch);
    units.push({
      index: units.length,
      filename: file.filename,
      hunk: null,
      header: `${file.filename} (${lines.filter(l => l.kind === 'hunk').length} hunks)`,
      patch: file.patch,
      changed: lines
        .filter(l => l.kind === 'added' || l.kind === 'removed')
        .map(l => l.text)
        .join('\n'),
      additions: file.additions,
      deletions: file.deletions,
      lines: { from: offset, to: offset + lines.length - 1 },
    });
    offset += lines.length;
  }
  return units;
}

/** The puffs the fly will smell for this pull request, and how they were chosen. */
export function reviewUnits(pr: PullRequest): { units: ReviewUnit[]; granularity: 'hunk' | 'file'; skipped: number } {
  const hunks = splitHunks(pr);
  if (hunks.length <= HUNK_LIMITS.units) return { units: hunks, granularity: 'hunk', skipped: 0 };
  const files = fileUnits(pr);
  if (files.length <= HUNK_LIMITS.units) return { units: files, granularity: 'file', skipped: 0 };
  const kept = [...files]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, HUNK_LIMITS.units)
    .sort((a, b) => a.index - b.index)
    .map((unit, index) => ({ ...unit, index }));
  return { units: kept, granularity: 'file', skipped: files.length - kept.length };
}

/** What Jev is shown for one unit: the hunk and the pull request's own words, never a verdict. */
export function unitState(pr: PullRequest, unit: ReviewUnit) {
  return {
    pullRequest: {
      url: pr.url,
      title: pr.title,
      description: pr.body,
      author: pr.author,
      base: pr.base,
      head: pr.head,
    },
    filename: unit.filename,
    hunk: unit.header,
    patch:
      unit.patch.length > HUNK_LIMITS.patch ? `${unit.patch.slice(0, HUNK_LIMITS.patch)}\n(truncated)` : unit.patch,
    contract:
      'No written contract was provided. Describe this hunk of the pull request using the code, the file name, and the pull request description.',
  };
}

/**
 * Did anything stand out? Novelty attention is only informative when the diff has a repetitive bulk: most hunks must
 * have gone quiet on the second reading, and the loudest must be clearly louder than the middle of the pack. A feature
 * PR where every hunk is new code fails both, and the honest headline is that nothing stood out.
 */
export function standsOut(
  hunks: { noveltyHz: number }[],
  looked: number,
): { stands: boolean; quiet: number; why: string } {
  const quiet = hunks.filter(h => h.noveltyHz === 0).length;
  const sorted = hunks.map(h => h.noveltyHz).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const top = hunks[looked]?.noveltyHz ?? 0;
  if (hunks.length < 3) return { stands: false, quiet, why: 'too few hunks for anything to be unlike the rest' };
  if (quiet * 2 < hunks.length)
    return {
      stands: false,
      quiet,
      why: `only ${quiet} of ${hunks.length} hunks went quiet; the hunks are each new in their own way, so nothing is unlike the rest`,
    };
  if (top < 3 || top < median * 1.5)
    return { stands: false, quiet, why: 'the loudest hunk is barely louder than the rest' };
  return { stands: true, quiet, why: `${quiet} of ${hunks.length} hunks went quiet and this one stayed loud` };
}

/**
 * When no hunk stands out, the fly still voted on every hunk it read. Counting those votes is its opinion of the pull
 * request: a majority of one verdict is the verdict, otherwise it abstains. Reached is counted alongside so the body's
 * vote is visible too. No new threshold: majority means more than half.
 */
export function tallyVotes(
  votes: { verdict: 'changes_requested' | 'no_objection' | 'abstain'; behavior: 'reached' | 'still' }[],
): {
  changes_requested: number;
  no_objection: number;
  abstain: number;
  reached: number;
  total: number;
  majority: 'changes_requested' | 'no_objection' | 'abstain';
} {
  const tally = {
    changes_requested: votes.filter(v => v.verdict === 'changes_requested').length,
    no_objection: votes.filter(v => v.verdict === 'no_objection').length,
    abstain: votes.filter(v => v.verdict === 'abstain').length,
    reached: votes.filter(v => v.behavior === 'reached').length,
    total: votes.length,
  };
  const majority =
    tally.changes_requested * 2 > tally.total
      ? 'changes_requested'
      : tally.no_objection * 2 > tally.total
        ? 'no_objection'
        : 'abstain';
  return { ...tally, majority };
}

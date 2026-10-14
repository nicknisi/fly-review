import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, ROOT } from './io.ts';
import { MEMORY_PATH, reviewVerdict, smellBrain, smellSequence } from './review-brain.ts';
import { reviewUnits } from './review-hunks.ts';
import type { Descriptors, ReviewBrain } from './review-brain.ts';
import { changedText } from './review-cases.ts';
import { fetchPullRequest, parsePullRequestRef, pullRequestCase, pullRequestKey } from './review-github.ts';
import { encodeUnitWithJev, encodeWithJev } from './review-jev.ts';
import type { LessonEntry } from './review-memory.ts';
import { hear, odorize } from './review-odor.ts';

/**
 * Smell real pull requests against a memory and say what the memory did. Nothing here teaches.
 *
 *   npm run smell:prs -- workos/authkit-nextjs#486 workos/authkit-nextjs#249
 *   MEMORY=.runs/trained-memory.json npm run smell:prs -- ...     (default: the live memory)
 *
 * For each PR: the naive vote, the vote with the memory, and the lessons whose Kenyon-cell code overlaps most with
 * this odor. Overlap is a similarity of odor codes, not a causal attribution. With ATTENTION=1 the pull request is also
 * read hunk by hunk (one Jev call per hunk, cached by head SHA) and the script reports where the fly looked.
 */
const refs = process.argv.slice(2).map(parsePullRequestRef);
if (refs.length === 0) throw new Error('Name at least one pull request, e.g. owner/repo#123');
const memoryPath = process.env.MEMORY ? join(ROOT, process.env.MEMORY) : MEMORY_PATH;
const seed = Number(process.env.SEED ?? 7);
const cachePath = join(ROOT, '.runs/pr-odors.json');
await mkdir(join(ROOT, '.runs'), { recursive: true });
type Unit = { features: Descriptors; changed: string; filename: string; hunk: number | null; header: string };
type Cached = Record<
  string,
  {
    head: string;
    model: string;
    at: string;
    features: Descriptors;
    changed: string;
    units?: Unit[];
    granularity?: 'hunk' | 'file';
  }
>;
let cached: Cached = {};
try {
  cached = JSON.parse(await readFile(cachePath, 'utf8')) as Cached;
} catch {
  /* first run */
}
const memory = JSON.parse(await readFile(memoryPath, 'utf8')) as { edges: unknown[]; lessons?: LessonEntry[] };
const lessons = (memory.lessons ?? []).filter(l => l.kenyonIds?.length);
const share = (b: ReviewBrain) => b.avoidHz / Math.max(1e-9, b.avoidHz + b.approachHz);
const jaccard = (a: number[], b: number[]) => {
  const B = new Set(b);
  const both = a.filter(id => B.has(id)).length;
  return both / (a.length + b.length - both);
};

const report = [];
for (const ref of refs) {
  const key = pullRequestKey(ref);
  const pr = await fetchPullRequest(ref);
  let entry = cached[key];
  if (!entry || entry.head !== pr.head) {
    const review = pullRequestCase(pr);
    const encoded = await encodeWithJev(review);
    entry = {
      head: pr.head,
      model: encoded.model,
      at: new Date().toISOString(),
      features: encoded.features,
      changed: changedText(review),
    };
    cached[key] = entry;
    await atomicJSON(cachePath, cached);
  }
  const odor = odorize(entry.features, entry.changed);
  const naive = await smellBrain(odor, { seed, memoryPath: null });
  const remembered = await smellBrain(odor, { seed, memoryPath });
  const nearest = lessons
    .map(l => ({
      caseId: l.caseId,
      title: l.title,
      lesson: l.lesson,
      smell: l.smell,
      overlap: jaccard(remembered.activeKenyonIds, l.kenyonIds!),
    }))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 5);
  const verdict = reviewVerdict(remembered);
  const strongest = Object.entries(hear(entry.features))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
  console.log(`\n${key}  ${pr.title}`);
  console.log(`  Jev: ${strongest}`);
  console.log(
    `  naive ${share(naive).toFixed(3)} -> with memory ${share(remembered).toFixed(3)}  ${verdict.verdict}  (avoid ${remembered.avoidHz.toFixed(0)} Hz, approach ${remembered.approachHz.toFixed(0)} Hz, ${remembered.rememberedSynapses.toLocaleString()} remembered synapses)`,
  );
  for (const n of nearest)
    console.log(
      `  smells ${(n.overlap * 100).toFixed(0)}% like ${n.caseId} (${n.lesson}${n.smell ? `, ${n.smell}` : ''}): ${n.title}`,
    );
  let attention = null;
  if (process.env.ATTENTION) {
    const plan = reviewUnits(pr);
    if (!entry.units || entry.units.length !== plan.units.length) {
      const units: Unit[] = [];
      for (let i = 0; i < plan.units.length; i += 4) {
        const batch = await Promise.all(plan.units.slice(i, i + 4).map(u => encodeUnitWithJev(pr, u)));
        units.push(
          ...batch.map((b, j) => {
            const u = plan.units[i + j];
            return { features: b.features, changed: u.changed, filename: u.filename, hunk: u.hunk, header: u.header };
          }),
        );
        entry.units = units;
        entry.granularity = plan.granularity;
        await atomicJSON(cachePath, cached);
      }
    }
    const units = entry.units!;
    const reading = await smellSequence(
      units.map(u => odorize(u.features, u.changed)),
      { seed, memoryPath },
    );
    const seq = reading.sequence!;
    const ranked = [...seq.hunks].sort((a, b) => b.noveltyHz - a.noveltyHz || a.index - b.index);
    const name = (i: number) => `${units[i].filename}${units[i].hunk === null ? '' : ` hunk ${units[i].hunk! + 1}`}`;
    attention = {
      granularity: entry.granularity,
      units: units.length,
      looked: seq.looked,
      lookedName: name(seq.looked),
      quiet: seq.hunks.filter(h => h.noveltyHz === 0).length,
      ranked: ranked.slice(0, 6).map(h => ({
        index: h.index,
        name: name(h.index),
        header: units[h.index].header,
        noveltyHz: h.noveltyHz,
        naiveNoveltyHz: h.naiveNoveltyHz,
        share: h.avoidHz + h.approachHz > 0 ? h.avoidHz / (h.avoidHz + h.approachHz) : 0.5,
      })),
      // Every hunk's own vote, the way the fly votes on a single change: a reach approves whatever the share says.
      hunks: seq.hunks.map(h => ({
        index: h.index,
        name: name(h.index),
        share: h.avoidHz + h.approachHz > 0 ? h.avoidHz / (h.avoidHz + h.approachHz) : 0.5,
        feedHz: h.feedHz ?? 0,
        verdict: reviewVerdict({ avoidHz: h.avoidHz, approachHz: h.approachHz, feedHz: h.feedHz ?? 0 }).verdict,
      })),
    };
    console.log(
      `  read ${units.length} ${entry.granularity}s twice; ${attention.quiet} went quiet. Looked at #${seq.looked + 1}: ${name(seq.looked)} (${units[seq.looked].header.slice(0, 70)})`,
    );
    for (const h of attention.ranked)
      console.log(
        `    novelty ${h.noveltyHz.toFixed(0)} of ${h.naiveNoveltyHz.toFixed(0)} Hz · share ${h.share.toFixed(2)} · ${h.name}`,
      );
  }
  report.push({
    pr: key,
    title: pr.title,
    head: pr.head,
    naive: share(naive),
    remembered: share(remembered),
    verdict: verdict.verdict,
    nearest,
    strongest,
    attention,
  });
}
await atomicJSON(join(ROOT, '.runs/pr-smells.json'), { at: new Date().toISOString(), memoryPath, seed, report });
console.log('\nEvidence: .runs/pr-smells.json');

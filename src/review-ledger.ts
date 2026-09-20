import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNS_ROOT } from './io.ts';
import type { FlyVerdict } from './review-brain.ts';
import type { VerificationReceipt } from './review-verify.ts';

/** One line per event in .runs/ledger.jsonl. The vote and its later verification share a runDir. */
export type LedgerEntry =
  | {
      type: 'vote';
      at: string;
      runDir: string | null;
      caseId: string;
      custom: boolean;
      feedHz: number;
      groomHz: number;
      escapeHz: number;
      verdict: FlyVerdict['verdict'];
    }
  | {
      type: 'verification';
      at: string;
      runDir: string | null;
      caseId: string;
      verdict: FlyVerdict['verdict'];
      status: VerificationReceipt['status'];
    };

/** The fly's record on this machine. Counts only, no code. */
export type Ledger = {
  trials: number;
  /** Trials in which each readout population fired at all: A feeding, B grooming, C escape. */
  fired: [number, number, number];
  /** Lowest and highest escape rate observed across trials, to show how little C moves. */
  escapeRange: [number, number] | null;
  verdicts: Record<FlyVerdict['verdict'], number>;
  verified: number;
  /** Confirmed regression after the fly raised no objection. */
  missed: number;
  /** Confirmed regression after the fly requested changes. */
  caught: number;
  /** No regression demonstrated after the fly requested changes. */
  falseAlarms: number;
};

const path = join(RUNS_ROOT, 'ledger.jsonl');
export const emptyLedger = (): Ledger => ({
  trials: 0,
  fired: [0, 0, 0],
  escapeRange: null,
  verdicts: { changes_requested: 0, no_objection: 0, abstain: 0 },
  verified: 0,
  missed: 0,
  caught: 0,
  falseAlarms: 0,
});

export function fold(ledger: Ledger, entry: LedgerEntry): Ledger {
  if (entry.type === 'vote') {
    ledger.trials++;
    [entry.feedHz, entry.groomHz, entry.escapeHz].forEach((hz, i) => {
      if (hz > 0) ledger.fired[i]++;
    });
    ledger.escapeRange = ledger.escapeRange
      ? [Math.min(ledger.escapeRange[0], entry.escapeHz), Math.max(ledger.escapeRange[1], entry.escapeHz)]
      : [entry.escapeHz, entry.escapeHz];
    ledger.verdicts[entry.verdict]++;
  } else {
    ledger.verified++;
    if (entry.status === 'confirmed' && entry.verdict === 'no_objection') ledger.missed++;
    if (entry.status === 'confirmed' && entry.verdict === 'changes_requested') ledger.caught++;
    if (entry.status === 'unsubstantiated' && entry.verdict === 'changes_requested') ledger.falseAlarms++;
  }
  return ledger;
}

export async function loadLedger(): Promise<Ledger> {
  const ledger = emptyLedger();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return ledger;
  }
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      fold(ledger, JSON.parse(line) as LedgerEntry);
    } catch {
      /* A damaged line is skipped, not fabricated. */
    }
  }
  return ledger;
}

export async function appendLedger(entry: LedgerEntry): Promise<void> {
  await mkdir(RUNS_ROOT, { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

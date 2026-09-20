import type { ReviewAction } from '../src/review-action.js';
import type { ReviewBrain } from '../src/review-brain.js';
import type { OdorMatch } from '../src/review-evidence.js';
import type { ReviewState } from '../src/review-types.js';
import { reviewVerdict } from '../src/review-verdict.js';

type Context = {
  state: () => ReviewState | null;
  latest: () => ReviewState | null;
  request: (action: ReviewAction) => Promise<void>;
  recall: () => void;
  pokeSugar: () => void;
};

export function initExperiments(ctx: Context) {
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = '/review-experiments.css';
  document.head.append(sheet);
  const section = document.createElement('section');
  section.className = 'memory-lab';
  section.id = 'memory-lab';
  section.setAttribute('aria-labelledby', 'memory-lab-title');
  section.innerHTML = `<div class="section-header"><h2 id="memory-lab-title">Cross-examine the fly</h2><span>Local experiments · no model calls</span></div>
    <p>Same odor. Same seed. An explicit memory. A changed vote is interesting; an unchanged vote is evidence, too.</p>
    <div id="memory-controls" class="lab-actions"><button id="memory-recall" class="quiet" disabled>Smell the same change again</button><button id="memory-compare" class="quiet" disabled>Compare with no memory</button></div>
    <p id="historical-recording" role="status" hidden>The displayed vote is historical: current memory was reset. Rerun the frozen inputs to measure a new vote.</p>
    <ol id="vote-history" class="vote-history" aria-label="Measured votes with frozen descriptors"></ol>
    <div id="memory-pair" hidden><h3>The fly takes the stand</h3><p>Current memory versus no memory, with identical odor and seed. This tests the effect of all memory, not one selected lesson. Your fly still remembers.</p><div id="memory-pair-results" class="lab-pair"></div><label for="comparison-bin">Inspect a recorded 25 ms bin</label><input id="comparison-bin" type="range" min="0" max="9" value="9"><output id="comparison-bin-output" for="comparison-bin"></output></div>
    <details class="odor-lineup"><summary>You smell familiar</summary><p>Recorded odor-code overlap, not causal attribution. Compare the active Kenyon-cell sets in saved, compatible lesson receipts. No new model or simulation.</p><button id="load-lineup" class="quiet" disabled>Compare familiar smells</button><p id="lineup-status" role="status"></p><ol id="lineup-results"></ol></details>
    <div class="sensory-lab"><h3>Spoil the sugar</h3><p>A sensory experiment, not a code review. Sugar does not reward a code change. Local setup is required; model keys are not.</p><div class="lab-actions"><button id="sugar-baseline" class="quiet">Try a local sugar poke</button><button id="add-bitter" class="quiet" disabled>Add bitter to the same sugar</button></div><div id="sugar-results" class="lab-pair" aria-live="polite"></div></div>`;
  document.getElementById('inspect')!.before(section);
  const get = <T extends HTMLElement = HTMLElement>(id: string) => section.querySelector<T>(`#${id}`)!;
  const keyless = document.createElement('button');
  keyless.id = 'keyless-poke';
  keyless.className = 'quiet';
  keyless.textContent = 'Try a local sugar poke. No API key needed.';
  document.getElementById('api-notice')!.append(keyless);
  keyless.addEventListener('click', ctx.pokeSugar);
  get('sugar-baseline').addEventListener('click', ctx.pokeSugar);
  get('add-bitter').addEventListener('click', () => void ctx.request({ action: 'add-bitter' }));
  get('memory-recall').addEventListener('click', ctx.recall);
  get('memory-compare').addEventListener('click', () => void ctx.request({ action: 'compare-memory' }));

  function receiptButton(id: string) {
    const button = document.createElement('button');
    button.className = 'link';
    button.textContent = 'Open saved receipt';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/review/receipt?id=${encodeURIComponent(id)}`);
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error ?? 'Receipt unavailable');
        const dialog = document.createElement('dialog');
        dialog.className = 'lab-receipt';
        const heading = document.createElement('h2');
        heading.textContent = `Saved receipt: ${id}`;
        const close = document.createElement('button');
        close.className = 'quiet';
        close.textContent = 'Close';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(receipt, null, 2);
        dialog.append(heading, close, pre);
        dialog.setAttribute('aria-label', `Saved receipt ${id}`);
        close.addEventListener('click', () => dialog.close());
        dialog.addEventListener(
          'close',
          () => {
            dialog.remove();
            button.focus();
          },
          { once: true },
        );
        document.body.append(dialog);
        dialog.showModal();
      } catch (error) {
        get('lineup-status').textContent = String(error);
        const notice = document.getElementById('error')!;
        notice.textContent = String(error);
        notice.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }
  function card(title: string, body: string, receipt?: string) {
    const div = document.createElement('div');
    const h = document.createElement('strong');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    div.append(h, p);
    if (receipt) div.append(receiptButton(receipt));
    return div;
  }
  function rates(brain: ReviewBrain) {
    const verdict = reviewVerdict(brain);
    return `${verdict.verdict.replaceAll('_', ' ')} · avoid ${brain.avoidHz.toFixed(1)} Hz / approach ${brain.approachHz.toFixed(1)} Hz · share ${verdict.score.toFixed(3)}`;
  }
  function renderBin() {
    const pair = ctx.state()?.memoryComparison;
    if (!pair) return;
    const index = Number(get<HTMLInputElement>('comparison-bin').value);
    const a = pair.current.frames[index],
      b = pair.naive.frames[index];
    get('comparison-bin-output').textContent =
      `${a.timeMs} ms: current memory MBONs ${a.avoidHz ?? 'unavailable'} / ${a.approachHz ?? 'unavailable'} Hz; no memory ${b.avoidHz ?? 'unavailable'} / ${b.approachHz ?? 'unavailable'} Hz (avoid / approach).`;
  }
  get('comparison-bin').addEventListener('input', renderBin);
  let lineupRequest: AbortController | null = null;
  get('load-lineup').addEventListener('click', async () => {
    lineupRequest?.abort();
    const owner = new AbortController();
    lineupRequest = owner;
    const run = ctx.state()?.runDir;
    get('lineup-status').textContent = 'Reading saved odor codes…';
    try {
      const response = await fetch('/api/review/lineup', { signal: owner.signal });
      const result = await response.json();
      if (lineupRequest !== owner || ctx.state()?.runDir !== run) return;
      if (!response.ok) throw new Error(result.error ?? 'Lineup unavailable');
      const matches = result.matches as OdorMatch[];
      get('lineup-results').replaceChildren(
        ...matches.map(match => {
          const li = document.createElement('li');
          li.append(
            card(
              match.title,
              `${match.shared}/${match.total} unique cells shared (${(match.overlap * 100).toFixed(1)}% Jaccard). Lesson: ${match.lesson}; executed outcome: ${match.status}.`,
              match.id,
            ),
          );
          return li;
        }),
      );
      get('lineup-status').textContent =
        `${matches.length} compatible saved matches. ${result.unavailable} missing or incompatible receipts are unavailable, not zero-overlap results.`;
    } catch (error) {
      if (lineupRequest === owner && !owner.signal.aborted) get('lineup-status').textContent = String(error);
    }
  });
  let lastHistory = '',
    lastPair = '',
    lastSugar = '',
    lastRun: string | null = null;
  function render() {
    const s = ctx.state(),
      latest = ctx.latest(),
      busy = !latest || latest.busy;
    const ready = Boolean(s?.brain && s.odor && s.memoryInput);
    for (const id of ['memory-recall', 'memory-compare', 'load-lineup'])
      get<HTMLButtonElement>(id).disabled = busy || !ready;
    get<HTMLButtonElement>('sugar-baseline').disabled = busy;
    keyless.disabled = busy;
    const sugar = latest?.poke;
    get<HTMLButtonElement>('add-bitter').disabled =
      busy || !sugar || !sugar.stimuli.sugar || Object.keys(sugar.stimuli).length !== 1;
    get('historical-recording').hidden = !s?.recordingHistorical;
    if (lastRun !== (s?.runDir ?? null)) {
      lastRun = s?.runDir ?? null;
      lineupRequest?.abort();
      lineupRequest = null;
      get('lineup-results').replaceChildren();
      get('lineup-status').textContent = '';
    }
    const history = JSON.stringify(s?.history ?? []);
    if (history !== lastHistory) {
      lastHistory = history;
      get('vote-history').replaceChildren(
        ...(s?.history ?? []).map(vote => {
          const li = document.createElement('li');
          li.append(
            card(
              vote.label,
              `${vote.verdict.verdict.replaceAll('_', ' ')} · share ${vote.verdict.score.toFixed(3)} · seed ${vote.seed} · memory ${vote.memoryHash.slice(0, 12)} · description ${vote.descriptorHash.slice(0, 12)}`,
              vote.runId,
            ),
          );
          return li;
        }),
      );
    }
    const pair = s?.memoryComparison;
    get('memory-pair').hidden = !pair;
    const pairKey = pair
      ? JSON.stringify([pair.memoryInput.hash, pair.current.seed, pair.current.wallMs, pair.naive.wallMs])
      : '';
    if (pair && pairKey !== lastPair) {
      get('memory-pair-results').replaceChildren(
        card('Current memory', rates(pair.current)),
        card('No memory (control only)', rates(pair.naive)),
      );
      renderBin();
    }
    lastPair = pairKey;
    const pokePair = latest?.pokePair;
    const sugarKey = JSON.stringify([sugar?.receiptId, pokePair?.mixed.receiptId]);
    if (sugarKey !== lastSugar) {
      lastSugar = sugarKey;
      const cards: HTMLElement[] = [];
      if (pokePair) {
        cards.push(
          card(
            'Sugar only',
            `MN9 ${pokePair.sugar.brain.feedHz.toFixed(1)} Hz · seed ${pokePair.sugar.brain.seed}`,
            pokePair.sugar.receiptId,
          ),
        );
        const delta = pokePair.mixed.brain.feedHz - pokePair.sugar.brain.feedHz;
        cards.push(
          card(
            'Same sugar + bitter',
            `MN9 ${pokePair.mixed.brain.feedHz.toFixed(1)} Hz. ${delta < 0 ? `Suppression observed: ${(-delta).toFixed(1)} Hz lower.` : 'No suppression observed in this trial.'} Same seed and saved memory; no learning.`,
            pokePair.mixed.receiptId,
          ),
        );
      } else if (sugar && Object.keys(sugar.stimuli).length === 1 && sugar.stimuli.sugar) {
        cards.push(
          card(
            'Sugar baseline recorded',
            `MN9 ${sugar.brain.feedHz.toFixed(1)} Hz · seed ${sugar.brain.seed}. Add bitter to change only that sensory population.`,
            sugar.receiptId,
          ),
        );
      }
      get('sugar-results').replaceChildren(...cards);
    }
  }
  document.getElementById('example')!.addEventListener('change', render);
  render();
  return { render };
}

import {
  REVIEW_CASES,
  DEFAULT_REVIEW_CASE,
  CUSTOM_CASE_ID,
  PULL_REQUEST_CASE_ID,
  changedRange,
  customReviewCase,
  diffLines,
  flyName,
  formatReviewInput,
  formatReviewValue,
  parsePatch,
} from '../src/review-cases.js';
import type { DiffLine, ReviewCase } from '../src/review-cases.js';
import type { FeatureKey, Features, ReviewBrain, ReviewFrame, BrainAnatomy } from '../src/review-brain.js';
import type { ReviewState } from '../src/review-types.js';
import type { ReviewAction } from '../src/review-action.js';
import { confirmCodeDisclosure } from './review-disclosure.js';
import type { LessonEntry } from '../src/review-memory.js';
import { BrainView } from './brain-view.js';
import { FlyAvatar, QUIPS, behavior, mushroomReading, quip } from './fly.js';
import type { Drive } from './fly.js';
import { Walkthrough } from './walkthrough.js';
import { VERDICT_RULE } from '../src/review-verdict.js';
import { standsOut } from '../src/review-hunks.js';
import { initExperiments } from './review-experiments.js';
import { FlyModel } from './fly-model.js';
import { DEFAULT_POKE_HZ, POKE_NAMES, POKE_PRESETS } from '../src/review-pokes.js';
import type { PokePreset } from '../src/review-pokes.js';
import {
  GLOMERULI,
  RECEPTORS,
  RECEPTOR_FLOOR,
  RECEPTOR_GLOMERULUS,
  RECEPTOR_KEYS,
  RECEPTOR_MAX_HZ,
  odorEntries,
} from '../src/review-odor.js';
import type { Odor } from '../src/review-odor.js';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const text = (id: string, value: string) => {
  if (el(id).textContent !== value) el(id).textContent = value;
};
const keys = RECEPTOR_KEYS as FeatureKey[];
const receptorOf = (key: FeatureKey) => RECEPTORS.find(r => r.key === key)!;
const manualDefault = 0.05;
const channelIds = ['a', 'b', 'c'] as const;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const narrow = () => matchMedia('(max-width: 780px)').matches && !el<HTMLDetailsElement>('inspect').open;
const view = new BrainView(el<HTMLCanvasElement>('neural'), label => {
  text('renderer', label);
  text(
    'interaction-hint',
    label.startsWith('WebGL ·') ? 'Drag / arrow keys to rotate · +/− zoom' : 'Same measured data · flat projection',
  );
  requestAnimationFrame(updateRotation);
});
view.rotating = !reduce.matches;

let state: ReviewState | null = null;
/** While the walkthrough is showing body language, it overrides the fly's drive; null hands the body back to the data. */
let flyOverride: Partial<Drive> | null = null;
const stateListeners = new Set<(s: ReviewState) => void>();
let mode: 'jev' | 'manual' | null = null;
let selected = DEFAULT_REVIEW_CASE.id,
  connected = false;
let boundRun: string | null = null,
  previousRun: string | null = null,
  knownRun: string | null = null;
let awaitingRun = false,
  pendingVerification = false,
  presenting = false;
let knownAblation: ReviewBrain | null = null;
let knownTeaching: string | null = null;
let recording: ReviewBrain | null = null;
/** A recording's stimuli are poke presets (named sensory populations) or an odor (`odor:ORN_x` glomeruli). Only pokes light a body part. */
function pokedPreset(stimuli: ReviewBrain['stimuli']): PokePreset | null {
  const first = stimuli && Object.keys(stimuli)[0];
  return first && first in POKE_PRESETS ? (first as PokePreset) : null;
}
let playbackKind: 'original' | 'disconnected' | 'poke' | 'lesson' = 'original';
let knownPoke: string | null = null;
let playing = false,
  revealed = false,
  elapsed = 0,
  lastAnimation = 0,
  frameIndex = 0,
  lastSoundFrame = -1;
let sounding = false,
  audio: AudioContext | null = null,
  noise: AudioBuffer | null = null;
let uiStamp = '';
let pullRequestPreview: ReviewCase | null = null,
  fetchingPr = false;
let previewRequest: AbortController | null = null;
let preparingReview = false;
let stampedRun: string | null = null;
let anatomy: BrainAnatomy | null = null;
const emptyActivity: [number, number, number, number][] = [];
// The reviewer: a lit 3D model when WebGL is available, the layered drawing otherwise. Same interface either way.
const reviewer: FlyAvatar | FlyModel = (() => {
  try {
    const model = new FlyModel(el('reviewer'));
    el('reviewer').classList.add('model');
    return model;
  } catch {
    return new FlyAvatar(el('reviewer'));
  }
})();
/** Playback pacing: a review shows the incoming signals for 1.2 s and then 480 ms per bin; a poke skips the preamble and runs twice as fast. */
const preambleMs = () => (playbackKind === 'poke' || playbackKind === 'lesson' ? 0 : 1200);
const binMs = () => (playbackKind === 'poke' ? 240 : 480);
const totalMs = () => preambleMs() + 10 * binMs();
const manual: Features = Object.fromEntries(keys.map(key => [key, manualDefault])) as Features;
const active = () => (state?.review.id === selected && state.runDir === boundRun ? state : null);

// The change selector: bundled examples, then a slot for your own diff.
for (const groupName of ['AI agent disasters', 'Time and data', 'Control experiment', 'Checkout classics']) {
  const group = document.createElement('optgroup');
  group.label = groupName;
  for (const review of REVIEW_CASES.filter(review => review.group === groupName)) {
    const option = document.createElement('option');
    option.value = review.id;
    option.textContent = review.title;
    group.append(option);
  }
  el<HTMLSelectElement>('example').append(group);
}
for (const [label, value, title] of [
  ['Your pull request', PULL_REQUEST_CASE_ID, 'Review a GitHub pull request…'],
  ['Your change', CUSTOM_CASE_ID, 'Paste your own change…'],
]) {
  const group = document.createElement('optgroup');
  group.label = label;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = title;
  group.append(option);
  el<HTMLSelectElement>('example').append(group);
}
el<HTMLSelectElement>('example').value = selected;

const customFields = ['custom-filename', 'custom-before', 'custom-after', 'custom-context'] as const;
const customInput = () => ({
  filename: el<HTMLInputElement>('custom-filename').value,
  before: el<HTMLTextAreaElement>('custom-before').value,
  after: el<HTMLTextAreaElement>('custom-after').value,
  context: el<HTMLTextAreaElement>('custom-context').value,
});
const emptyPullRequestCase: ReviewCase = {
  id: PULL_REQUEST_CASE_ID,
  title: 'Your pull request',
  group: 'Your pull request',
  filename: 'pull request',
  context: '',
  before: '',
  after: '',
  functionName: 'pullRequest',
  contract: null,
  parameters: [],
  oracle: null,
  format: 'text',
  custom: true,
};
/** The case being displayed. A pasted change is shown even while it is still invalid; validation happens on submit. */
function currentCase(): ReviewCase {
  if (selected === PULL_REQUEST_CASE_ID) return pullRequestPreview ?? emptyPullRequestCase;
  if (selected !== CUSTOM_CASE_ID) return REVIEW_CASES.find(c => c.id === selected)!;
  const input = customInput();
  try {
    return customReviewCase(input);
  } catch {
    return {
      id: CUSTOM_CASE_ID,
      title: 'Your change',
      group: 'Your change',
      filename: input.filename.trim() || 'change.ts',
      context: input.context,
      before: input.before,
      after: input.after,
      functionName: 'change',
      contract: null,
      parameters: [],
      oracle: null,
      format: 'text',
      custom: true,
    };
  }
}
function fillCustomForm(review: ReviewCase) {
  el<HTMLInputElement>('custom-filename').value = review.filename;
  el<HTMLTextAreaElement>('custom-before').value = review.before;
  el<HTMLTextAreaElement>('custom-after').value = review.after;
  el<HTMLTextAreaElement>('custom-context').value =
    review.context === 'No caller context was provided.' ? '' : review.context;
}

for (const key of keys) {
  const row = document.createElement('div');
  row.className = 'feature';
  const label = document.createElement('label');
  label.htmlFor = `input-${key}`;
  label.textContent = receptorOf(key).label;
  const value = document.createElement('output');
  value.className = 'reading';
  value.id = `value-${key}`;
  const input = document.createElement('input');
  input.type = 'range';
  input.id = `input-${key}`;
  input.min = '0';
  input.max = '100';
  input.value = String(manualDefault * 100);
  input.disabled = true;
  const rate = document.createElement('span');
  rate.className = 'encoded-rate';
  rate.id = `rate-${key}`;
  input.addEventListener('input', () => {
    manual[key] = Number(input.value) / 100;
    renderFeatures();
  });
  row.append(label, value, input, rate);
  el('features').append(row);
  const question = document.createElement('li');
  question.textContent = `${receptorOf(key).label}: ${receptorOf(key).question}`;
  el('questions').append(question);
}
// The odor strip: one bar per glomerulus, receptors first, lexical glomeruli after.
for (const [i, glomerulus] of GLOMERULI.entries()) {
  const bar = document.createElement('i');
  bar.id = `glom-${glomerulus}`;
  bar.dataset.kind = i < RECEPTORS.length ? 'receptor' : 'lexical';
  bar.title = i < RECEPTORS.length ? `${RECEPTORS[i].label} → ${glomerulus}` : `lexical receptor → ${glomerulus}`;
  el('odor-strip').append(bar);
}
function renderOdor(odor: Odor | null) {
  el('odor').hidden = !odor;
  const entries = odorEntries(odor ?? {});
  for (const entry of entries) {
    const bar = el(`glom-${entry.glomerulus}`);
    bar.style.setProperty('--hz', String(entry.hz / RECEPTOR_MAX_HZ));
    bar.style.setProperty('--i', String(entries.indexOf(entry)));
    bar.classList.toggle('on', entry.hz > 0);
  }
  const driven = entries.filter(e => e.hz > 0);
  text(
    'odor-summary',
    odor
      ? `${driven.length} of 53 glomeruli driven: ${driven.filter(e => e.receptor).length} by Jev’s receptors, ${driven.filter(e => !e.receptor).length} by the tokens in the changed lines.`
      : '',
  );
}

function renderPullRequest(review: ReviewCase) {
  const pr = review.pullRequest;
  el('pr-head').hidden = !pr;
  if (!pr) return;
  text('pr-title', pr.title);
  el('pr-meta').replaceChildren(
    document.createTextNode(
      `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} · ${pr.author} · ${pr.head} → ${pr.base} · ${pr.changedFiles} files +${pr.additions} −${pr.deletions} · `,
    ),
    Object.assign(document.createElement('a'), {
      href: pr.url,
      target: '_blank',
      rel: 'noopener',
      textContent: 'open on GitHub',
    }),
  );
}
/** How many puffs a fetched pull request will be read as: hunks, or files past 32 hunks, capped at 32. */
function hunkCount(review: ReviewCase): number {
  const files = review.pullRequest?.files.filter(f => f.patch) ?? [];
  const hunks = files.reduce(
    (n, f) =>
      n + parsePatch(f.patch!).filter(l => l.kind === 'hunk' && !l.text.startsWith('@@ patch truncated')).length,
    0,
  );
  return hunks <= 32 ? hunks : Math.min(32, files.length);
}
function renderDiff() {
  const review = currentCase();
  el('custom-form').hidden = selected !== CUSTOM_CASE_ID;
  el('pr-form').hidden = selected !== PULL_REQUEST_CASE_ID;
  if (selected === PULL_REQUEST_CASE_ID) renderPullRequest(review);
  text(
    'contract',
    review.contract ??
      (review.pullRequest
        ? 'No written contract. A pull request gets a vote, not a test.'
        : 'No written contract. A pasted change gets a vote, not a test.'),
  );
  text('hunk-range', changedRange(review));
  text('caller-context', review.context);
  let lines: DiffLine[];
  el('diff-shell').classList.toggle('full', Boolean(review.pullRequest));
  if (review.pullRequest) {
    // The whole pull request, file after file, in the order Jev sees it. Omitted patches say why.
    const pr = review.pullRequest;
    text('filename', `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`);
    lines = pr.files.flatMap(file => [
      {
        kind: 'file' as const,
        beforeLine: null,
        afterLine: null,
        text: `${file.status === 'added' ? '+' : file.status === 'removed' ? '−' : '±'} ${file.previousFilename ? `${file.previousFilename} → ` : ''}${file.filename}  +${file.additions} −${file.deletions}${file.patch === null ? `  (patch omitted: ${file.omitted})` : ''}`,
      },
      ...(file.patch === null ? [] : parsePatch(file.patch)),
    ]);
  } else {
    text('filename', review.filename);
    lines = review.before || review.after ? diffLines(review.before, review.after) : [];
  }
  let fileName = '',
    hunkIndex = -1;
  el('diff').replaceChildren(
    ...lines.map((line, i) => {
      const row = document.createElement('span');
      row.className = `diff-line ${line.kind}`;
      row.style.setProperty('--i', String(Math.min(i, 40)));
      // Rows remember which file and hunk they belong to, numbered the way the server numbers its puffs.
      if (line.kind === 'file') {
        fileName = line.text
          .replace(/^[+−±] /, '')
          .replace(/^.* → /, '')
          .replace(/ {2}.*$/, '');
        hunkIndex = -1;
      } else if (line.kind === 'hunk' && !line.text.startsWith('@@ patch truncated')) hunkIndex++;
      if (review.pullRequest && line.kind !== 'file') {
        row.dataset.file = fileName;
        row.dataset.hunk = String(hunkIndex);
      }
      const gutter = document.createElement('span');
      gutter.className = 'gutter';
      gutter.textContent =
        line.kind === 'hunk' || line.kind === 'file'
          ? ''
          : `${line.afterLine ?? line.beforeLine ?? ''} ${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}`;
      row.append(gutter, document.createTextNode(line.text));
      return row;
    }),
  );
  if (selected === PULL_REQUEST_CASE_ID && !pullRequestPreview)
    el('diff').replaceChildren(
      Object.assign(document.createElement('span'), {
        className: 'diff-line hunk',
        textContent: 'Paste a pull request URL above and fetch it.',
      }),
    );
}

async function fetchPullRequestPreview() {
  const reference = el<HTMLInputElement>('pr-url').value.trim();
  if (!reference || fetchingPr) return;
  const owner = new AbortController();
  previewRequest = owner;
  fetchingPr = true;
  el<HTMLButtonElement>('pr-fetch').disabled = true;
  const status = el('pr-status');
  status.className = 'pr-status';
  status.textContent = 'Fetching from GitHub…';
  try {
    const response = await fetch(`/api/pull-request?ref=${encodeURIComponent(reference)}`, { signal: owner.signal });
    const body = await response.json();
    if (previewRequest !== owner || reference !== el<HTMLInputElement>('pr-url').value.trim()) return;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    pullRequestPreview = body as ReviewCase;
    const pr = pullRequestPreview.pullRequest!,
      shown = pr.files.filter(f => f.patch !== null).length;
    status.textContent = `Fetched. ${shown} of ${pr.files.length} patches will be shown to Jev (${(pr.shownPatchChars / 1000).toFixed(1)} KB)${shown < pr.files.length ? '; the rest are listed by name' : ''}.`;
    resetSelection();
    if (state?.review.pullRequest?.url === pr.url && state.runDir) {
      boundRun = state.runDir;
      knownRun = null;
      knownAblation = null;
      knownTeaching = null;
      render(state);
    }
  } catch (error) {
    if (previewRequest !== owner || owner.signal.aborted) return;
    pullRequestPreview = null;
    status.className = 'pr-status error';
    status.textContent = String(error instanceof Error ? error.message : error);
    resetSelection();
  } finally {
    if (previewRequest === owner) {
      previewRequest = null;
      fetchingPr = false;
      el<HTMLButtonElement>('pr-fetch').disabled = false;
    }
  }
}

function renderFeatures() {
  const s = active();
  for (const key of keys) {
    const value = mode === 'manual' ? manual[key] : s?.features?.[key];
    const input = el<HTMLInputElement>(`input-${key}`);
    input.disabled = mode !== 'manual' || Boolean(state?.busy);
    if (mode === 'jev') input.value = String((value ?? 0) * 100);
    text(`value-${key}`, value === undefined ? 'Awaiting Jev' : `${Math.round(value * 100)}%`);
    const glomerulus = RECEPTOR_GLOMERULUS[key];
    text(
      `rate-${key}`,
      value === undefined
        ? 'No description yet'
        : value < RECEPTOR_FLOOR
          ? `below the ${Math.round(RECEPTOR_FLOOR * 100)}% floor: ${glomerulus} stays quiet`
          : `${(value * RECEPTOR_MAX_HZ).toFixed(0)} Hz → ${glomerulus}`,
    );
  }
  // What Jev noticed: receptors above 50%, as cards. Descriptions, not verdicts.
  const noticed = s?.features
    ? RECEPTORS.filter(r => s.features![r.key] >= 0.5).sort((a, b) => s.features![b.key] - s.features![a.key])
    : [];
  el('signal-cards').replaceChildren(
    ...noticed.slice(0, 9).map(r => {
      const card = document.createElement('div');
      card.className = 'signal-card on';
      card.title = `${r.question} Jev: ${Math.round(s!.features![r.key] * 100)}%. This drives ${RECEPTOR_GLOMERULUS[r.key]}.`;
      const name = document.createElement('span');
      name.textContent = r.label;
      const value = document.createElement('b');
      value.textContent = `${Math.round(s!.features![r.key] * 100)}%`;
      card.append(name, value);
      return card;
    }),
  );
  el('signal-cards').hidden = !s?.features || !noticed.length;
  renderOdor(s?.odor ?? null);
  const displayedSource = s?.source ?? mode;
  text('describe-title', displayedSource === 'manual' ? 'You describe.' : 'Jev describes.');
  text(
    'input-story',
    displayedSource === 'manual'
      ? 'Human-set descriptors. No model reads the code in manual mode.'
      : s?.features
        ? `Jev answered thirty descriptive questions; ${noticed.length} came back above 50%. With the changed tokens, that is the smell of this change. Nothing here is good or bad; the fly’s memory decides that.`
        : 'Jev answers thirty descriptive questions about what changed. Those answers and the changed tokens become an odor. The fly never reads the source code, and nobody tells it what is good.',
  );
  text(
    'mode-explanation',
    mode === 'manual'
      ? 'Explicit human-set neutral descriptors. Sliders configure the next trial; stored recordings keep their original values.'
      : mode === 'jev'
        ? 'Thirty live descriptive Nouls. None asks whether to approve or reject; they only shape the smell.'
        : 'Live Jev is unavailable. Select manual inputs explicitly to continue without it.',
  );
  el<HTMLButtonElement>('review').disabled =
    !mode || !connected || Boolean(state?.busy) || (mode === 'jev' && !state?.hasJev);
  text('review', state?.busy ? 'Experiment running…' : mode === 'manual' ? 'Send manual inputs ↗' : 'Ask the fly ↗');
  text(
    'billing',
    mode === 'manual'
      ? 'Manual inputs. No Jev call. Real neural simulation.'
      : selected === CUSTOM_CASE_ID
        ? 'One live Jev call reads your pasted code. Neural simulation runs locally. Nothing is executed.'
        : selected === PULL_REQUEST_CASE_ID
          ? `One live Jev call per hunk${pullRequestPreview ? ` (${hunkCount(pullRequestPreview)} here)` : ''}. The fly reads them in order, twice. Neural simulation runs locally. Nothing is executed.`
          : 'One live Jev call. Neural simulation runs locally.',
  );
  for (const id of customFields) el<HTMLInputElement>(id).disabled = Boolean(state?.busy);
  if (selected === PULL_REQUEST_CASE_ID && !pullRequestPreview) el<HTMLButtonElement>('review').disabled = true;
}

function play(brain: ReviewBrain, kind: 'original' | 'disconnected' | 'poke' | 'lesson') {
  recording = brain;
  playbackKind = kind;
  elapsed = 0;
  frameIndex = 0;
  lastSoundFrame = -1;
  playing = !reduce.matches;
  if (kind === 'original') revealed = reduce.matches;
  if (reduce.matches) {
    elapsed = totalMs();
    frameIndex = 9;
  }
  if (brain.geometry3d?.length && brain.links3d)
    view.setAnatomy({
      neurons: brain.neurons,
      connections: brain.connections,
      geometry3d: brain.geometry3d,
      links3d: brain.links3d,
      readouts3d: brain.readouts3d,
      mushroom3d: brain.mushroom3d,
    });
  el<HTMLButtonElement>('pause').disabled = false;
  el<HTMLInputElement>('scrub').disabled = false;
  uiStamp = '';
  updateStory();
  if (reduce.matches) presentVote();
}
function presentVote() {
  if (!presenting || playbackKind !== 'original') return;
  presenting = false;
  if (narrow()) el('verdict').scrollIntoView({ behavior: reduce.matches ? 'instant' : 'smooth', block: 'nearest' });
}

// Sound is driven by the recorded data: total spikes per bin set the crackle, readout spikes ring.
function ensureAudio(): AudioContext {
  audio ??= new AudioContext();
  void audio.resume();
  if (!noise) {
    noise = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return audio;
}
function crackle(frame: ReviewFrame, maxSpikes: number) {
  if (!sounding) return;
  const ctx = ensureAudio(),
    t = ctx.currentTime,
    share = Math.min(1, frame.spikes / Math.max(1, maxSpikes));
  const source = ctx.createBufferSource();
  source.buffer = noise!;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 700 + 1900 * share;
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.003 + 0.07 * share, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.44);
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(t);
  source.stop(t + 0.46);
  // One ping per readout population that spiked in this bin: A high, B middle, C a low thud.
  const counts = frame.readoutCounts?.map(population => population.reduce((sum, n) => sum + n, 0)) ?? [0, 0, 0];
  [
    [523, 'sine', 0.05],
    [330, 'triangle', 0.05],
    [82, 'sine', 0.018],
  ].forEach(([frequency, type, level], i) => {
    if (!counts[i]) return;
    const oscillator = ctx.createOscillator(),
      g = ctx.createGain();
    oscillator.type = type as OscillatorType;
    oscillator.frequency.value = frequency as number;
    g.gain.setValueAtTime(Math.min(0.12, (level as number) * Math.sqrt(counts[i])), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t + (i === 2 ? 0.3 : 0.22));
    oscillator.connect(g).connect(ctx.destination);
    oscillator.start(t + 0.02);
    oscillator.stop(t + 0.32);
  });
}
function thud() {
  if (!sounding) return;
  const ctx = ensureAudio(),
    t = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(110, t);
  oscillator.frequency.exponentialRampToValueAtTime(38, t + 0.18);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.22, t);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.28);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(t);
  oscillator.stop(t + 0.3);
  const source = ctx.createBufferSource();
  source.buffer = noise!;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.09, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
  source.connect(filter).connect(g).connect(ctx.destination);
  source.start(t);
  source.stop(t + 0.14);
}
function chime() {
  if (!sounding) return;
  const ctx = ensureAudio();
  [392, 330, 262].forEach((frequency, i) => {
    const oscillator = ctx.createOscillator(),
      gain = ctx.createGain(),
      at = ctx.currentTime + i * 0.09;
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.035, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.14);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.15);
  });
}

/**
 * Where the fly looked. A pull request is read hunk by hunk; each hunk's novelty readout (the α'3 MBONs on the frozen
 * second reading) tints its rows, and the loudest one is marked. The list under the vote gives every hunk's numbers.
 */
function renderAttention(s: ReviewState) {
  const box = el('attention');
  const a = s.attention;
  document.querySelectorAll<HTMLElement>('#diff .diff-line[data-file]').forEach(row => {
    row.classList.remove('looked', 'smelled');
    row.style.removeProperty('--novelty');
  });
  document.querySelectorAll('.looked-marker').forEach(m => m.remove());
  if (!a || s.review.pullRequest === undefined) {
    box.hidden = true;
    return;
  }
  const max = Math.max(1, ...a.units.map(u => u.reading.noveltyHz));
  const stood = standsOut(
    a.units.map(u => u.reading),
    a.looked,
  );
  for (const unit of a.units) {
    const rows = [...document.querySelectorAll<HTMLElement>('#diff .diff-line[data-file]')].filter(
      row => row.dataset.file === unit.filename && (unit.hunk === null || row.dataset.hunk === String(unit.hunk)),
    );
    for (const row of rows) {
      row.classList.add('smelled');
      row.style.setProperty('--novelty', (unit.reading.noveltyHz / max).toFixed(3));
      if (unit.index === a.looked) row.classList.add('looked');
    }
    const header = rows.find(row => row.classList.contains('hunk')) ?? rows[0];
    if (header && unit.index === a.looked && stood.stands) {
      const marker = document.createElement('span');
      marker.className = 'looked-marker';
      marker.textContent = `looked here · ${unit.reading.noveltyHz.toFixed(0)} Hz`;
      marker.title = `${flyName(s.brain!.seed)} looked here: novelty ${unit.reading.noveltyHz.toFixed(0)} Hz on the second reading, ${unit.reading.naiveNoveltyHz.toFixed(0)} Hz on first exposure`;
      header.append(marker);
    }
  }
  const looked = a.units[a.looked];
  box.hidden = false;
  text(
    'attention-lead',
    `${a.units.length} ${a.granularity}s read in order, then read again with the familiarity synapses frozen${a.skipped ? ` (${a.skipped} smaller files not smelled)` : ''}. Novelty is what each ${a.granularity} still evoked on the second reading, against what it evoked on first exposure. ${stood.stands ? `The vote above is for the ${a.granularity} it looked at` : `The vote above is for the loudest ${a.granularity}, which did not stand out`}: ${looked.filename}${looked.hunk === null ? '' : `, hunk ${looked.hunk + 1}`}.`,
  );
  el('attention-list').replaceChildren(
    ...[...a.units]
      .sort((x, y) => y.reading.noveltyHz - x.reading.noveltyHz || x.index - y.index)
      .map(unit => {
        const li = document.createElement('li');
        if (unit.index === a.looked) li.classList.add('looked');
        const reached = (unit.reading.feedHz ?? 0) >= VERDICT_RULE.reachHz;
        li.dataset.vote = reached
          ? 'approach'
          : unit.share >= VERDICT_RULE.objection
            ? 'avoid'
            : unit.share <= VERDICT_RULE.approval
              ? 'approach'
              : 'abstain';
        const bar = document.createElement('span');
        bar.className = 'novelty-bar';
        bar.style.setProperty('--novelty', (unit.reading.noveltyHz / max).toFixed(3));
        const name = document.createElement('span');
        name.className = 'unit-name';
        name.textContent = `${unit.filename}${unit.hunk === null ? '' : ` · hunk ${unit.hunk + 1}`}`;
        const nums = document.createElement('span');
        nums.className = 'unit-numbers';
        nums.textContent = `novelty ${unit.reading.noveltyHz.toFixed(0)} of ${unit.reading.naiveNoveltyHz.toFixed(0)} Hz · share ${unit.share.toFixed(2)}${reached ? ` · reached, MN9 ${unit.reading.feedHz!.toFixed(0)} Hz` : ''}`;
        li.append(bar, name, nums);
        li.addEventListener('click', () => {
          document
            .querySelector(
              `#diff .diff-line[data-file="${CSS.escape(unit.filename)}"]${unit.hunk === null ? '' : `[data-hunk="${unit.hunk}"]`}`,
            )
            ?.scrollIntoView({ block: 'center', behavior: reduce.matches ? 'auto' : 'smooth' });
        });
        return li;
      }),
  );
}
/**
 * Which taught odors this trial's Kenyon-cell code resembles. This is a similarity between odor codes, computed on the
 * server from the same active cells that drove the vote; it does not say the memory caused the vote.
 */
function renderNearest(s: ReviewState) {
  const box = el('nearest');
  const near = (s.nearest ?? []).filter(n => n.shared > 0).slice(0, 3);
  const untaught = s.review.oracle === null;
  if (!near.length) {
    box.hidden = !untaught;
    if (untaught) {
      text(
        'nearest-lead',
        s.memory.lessons.length
          ? 'None of the odors it was taught share a Kenyon cell with this one. Whatever it voted, it was not from memory.'
          : 'A naive fly: no odor has ever been paired with an outcome, so this vote is the untrained baseline.',
      );
      el('nearest-list').replaceChildren();
    }
    return;
  }
  box.hidden = false;
  const top = near[0];
  text(
    'nearest-lead',
    untaught
      ? top.overlap >= 0.4
        ? 'It has been taught odors like this one. The closest:'
        : top.overlap >= 0.2
          ? 'It has been taught odors somewhat like this one. The closest:'
          : 'Nothing it was taught smells much like this. The closest, faintly:'
      : 'Taught odors this one resembles most:',
  );
  el('nearest-list').replaceChildren(
    ...near.map(n => {
      const li = document.createElement('li');
      li.dataset.lesson = n.lesson;
      const pct = document.createElement('b');
      pct.textContent = `${Math.round(n.overlap * 100)}%`;
      const what = document.createElement('span');
      what.textContent = `${n.lesson === 'punish' ? 'punished' : 'rewarded'}: ${n.title}${n.smell ? ` (${n.smell.replace(/-/g, ' ')})` : ''}, ${n.shared} shared Kenyon cells`;
      li.append(pct, what);
      return li;
    }),
  );
}
function renderMemory(s: ReviewState) {
  const m = s.memory;
  const trained = m.lessons.filter(l => l.source === 'training');
  const live = m.lessons.filter(l => l.source !== 'training');
  const counts = (list: typeof m.lessons) =>
    `${list.filter(l => l.lesson === 'punish').length} punishments, ${list.filter(l => l.lesson === 'reward').length} rewards`;
  text(
    'memory-summary',
    m.lessons.length
      ? `${m.rememberedSynapses.toLocaleString()} KC → MBON synapses differ from the connectome after ${m.lessons.length} lesson${m.lessons.length === 1 ? '' : 's'}.${trained.length ? ` ${trained.length} came from training on executed cases (${counts(trained)}).` : ''}${live.length ? ` ${live.length} from tests run on this page (${counts(live)}).` : ''}`
      : 'A naive fly. Every KC → MBON synapse is at its connectome strength; nothing has taught it yet.',
  );
  el<HTMLButtonElement>('forget').disabled = s.busy || !connected || (!m.lessons.length && !m.rememberedSynapses);
  el('memory-log').replaceChildren(
    ...[...live]
      .reverse()
      .slice(0, 12)
      .map(entry => {
        const li = document.createElement('li');
        li.dataset.lesson = entry.lesson;
        const time = document.createElement('time');
        time.textContent = new Date(entry.at).toLocaleTimeString('en-US', { hour12: false });
        li.append(
          time,
          document.createTextNode(
            `${entry.lesson === 'punish' ? 'Punished' : 'Rewarded'} for ${entry.title}: ${entry.depressed.toLocaleString()} synapses.`,
          ),
        );
        return li;
      }),
  );
  const rec = el('record-detail');
  if (m.lessons.length && !rec.textContent?.includes('lesson'))
    rec.textContent += ` ${m.lessons.length} lesson${m.lessons.length === 1 ? '' : 's'} learned.`;
}
function renderRecord(s: ReviewState) {
  const l = s.ledger;
  if (!l.trials) {
    text('record-headline', 'No votes recorded yet.');
    text('record-detail', 'The fly’s record on this machine appears here.');
    text('channel-record', '');
    return;
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  text('record-headline', `${plural(l.trials, 'vote')} on this machine.`);
  const outcomes = l.verified
    ? ` Tests: approved ${plural(l.missed, 'confirmed regression')}, caught ${l.caught}, ${plural(l.falseAlarms, 'unsubstantiated objection')}.`
    : '';
  text(
    'record-detail',
    `${l.verdicts.changes_requested} changes requested, ${l.verdicts.no_objection} no objection, ${l.verdicts.abstain} abstained.${outcomes}`,
  );
  text(
    'channel-record',
    `Record on this machine: A fired in ${l.fired[0]} of ${l.trials} trials, B in ${l.fired[1]} of ${l.trials}, C in ${l.fired[2]} of ${l.trials}${l.escapeRange ? `, staying between ${l.escapeRange[0].toFixed(0)} and ${l.escapeRange[1].toFixed(0)} Hz` : ''}.`,
  );
}

function stamp(s: ReviewState | null, hasVote: boolean) {
  const badge = el('stamp');
  if (!hasVote || !s?.verdict || playbackKind !== 'original') {
    badge.hidden = true;
    if (!s?.brain) stampedRun = null;
    return;
  }
  const v = s.verdict.verdict;
  badge.dataset.vote = v;
  badge.textContent =
    v === 'changes_requested'
      ? 'Changes requested'
      : v === 'no_objection'
        ? s.verdict.behavior === 'reached'
          ? 'Reached for it'
          : 'No objection'
        : 'Abstained';
  if (badge.hidden || stampedRun !== s.runDir) {
    badge.hidden = false;
    badge.classList.remove('slam');
    void badge.offsetWidth;
    badge.classList.add('slam');
    if (stampedRun !== s.runDir) {
      stampedRun = s.runDir;
      thud();
      view.focusReadout(v === 'no_objection' ? 0 : v === 'changes_requested' ? 2 : null);
    }
  }
}

function updateStory() {
  const s = active(),
    hasVote = Boolean(s?.brain && revealed),
    busy = Boolean(state?.busy);
  el('verdict').hidden = !hasVote;
  for (const id of ['disconnect', 'repeat', 'second-opinion'])
    el<HTMLButtonElement>(id).disabled = !hasVote || busy || !connected;
  const canPost = Boolean(s?.review.pullRequest) && Boolean(state?.hasGitHub);
  el('post-review').hidden = !hasVote || !canPost || Boolean(s?.posted);
  el<HTMLButtonElement>('post-review').disabled = busy || !connected;
  el('posted').hidden = !hasVote || !s?.posted;
  if (s?.posted)
    el('posted').replaceChildren(
      document.createTextNode('The fly left its review: '),
      Object.assign(document.createElement('a'), {
        href: s.posted.url,
        target: '_blank',
        rel: 'noopener',
        textContent: 'see it on GitHub',
      }),
    );
  const verifiable = Boolean(s?.hasInvestigator) && s?.review.oracle !== null;
  el<HTMLButtonElement>('verify').disabled = !hasVote || busy || !verifiable || !connected;
  el<HTMLButtonElement>('replay').disabled = !s?.brain || busy;
  el('play-original').hidden = !(
    playbackKind === 'disconnected' ||
    playbackKind === 'lesson' ||
    (playbackKind === 'poke' && Boolean(s?.brain))
  );
  el<HTMLButtonElement>('play-original').disabled = busy;
  text('pause', playing ? 'Pause' : 'Play');
  const inspectingAblation = playbackKind === 'disconnected' && Boolean(recording);
  const poking = playbackKind === 'poke' && Boolean(recording?.stimuli);
  const teaching = playbackKind === 'lesson' && recording?.teaching ? recording.teaching : null;
  let step = 1;
  if (s?.phase === 'simulating' || s?.brain) step = 2;
  if (hasVote && (s?.phase === 'investigating' || s?.verification)) step = 3;
  for (const li of document.querySelectorAll<HTMLElement>('[data-step]')) {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === step);
    li.classList.toggle('done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  // The rail shows the six strongest glomeruli of the odor entering the scene.
  const strongest = odorEntries(s?.odor ?? {})
    .filter(e => e.hz > 0)
    .sort((a, b) => b.hz - a.hz)
    .slice(0, 6);
  document.querySelectorAll<HTMLElement>('#signal-rail i').forEach((rail, index) => {
    const entry = strongest[index];
    rail.classList.toggle('off', !entry);
    rail.dataset.strength = !entry ? 'low' : entry.hz >= 100 ? 'high' : entry.hz <= 50 ? 'low' : 'medium';
    rail.dataset.valence = entry?.receptor ? 'receptor' : 'lexical';
  });
  el('signal-rail').classList.toggle(
    'on',
    !reduce.matches && strongest.length > 0 && (s?.phase === 'simulating' || (playing && elapsed < preambleMs())),
  );
  if (state?.poking) {
    text('scene-label', 'Poke · simulation running');
    text('scene-title', 'You touched the fly.');
    text('scene-subtitle', 'Stimulating one real sensory population. Recording what reaches the six readouts.');
  } else if (teaching) {
    const bitter = teaching.pathway === 'bitter+ppl1';
    const byGroup = { avoid: 0, approach: 0, novelty: 0 };
    for (const c of Object.values(teaching.compartments)) byGroup[c.group] += c.depressed;
    text('scene-label', `Lesson · ${bitter ? 'bitter' : 'sugar'} on the tongue · recorded`);
    text('scene-title', bitter ? 'Bitter with the smell.' : 'Sugar with the smell.');
    text(
      'scene-subtitle',
      `The pink cells are its dopamine neurons firing: ${bitter ? `PPL1, punishment, ${teaching.ppl1Spikes.toLocaleString()} spikes` : `PAM, reward, ${teaching.pamSpikes.toLocaleString()} spikes`}. Every 5 ms, a synapse from a lit Kenyon cell was weakened wherever that dopamine landed: ${recording!.depressed.toLocaleString()} synapses, ${bitter ? `${byGroup.approach.toLocaleString()} onto approach MBONs` : `${byGroup.avoid.toLocaleString()} onto avoidance MBONs`}. The wiring chose where.`,
    );
  } else if (poking && recording?.stimuli && pokedPreset(recording.stimuli)) {
    const stimuli = recording.stimuli as Record<PokePreset, number>,
      names = (Object.keys(stimuli) as PokePreset[]).filter(n => n in POKE_PRESETS),
      sizes = recording.pokes;
    text('scene-label', `Poke · ${names.map(n => POKE_PRESETS[n].label).join(' + ')}`);
    text('scene-title', names.length === 1 ? `${POKE_PRESETS[names[0]].label}.` : 'A combined poke.');
    text(
      'scene-subtitle',
      `${names.map(n => `${sizes?.[n]?.toLocaleString() ?? 'the'} ${POKE_PRESETS[n].population} at ${stimuli[n]} Hz`).join('; ')}. In a living fly: ${names.map(n => POKE_PRESETS[n].expect).join('; ')}.`,
    );
  } else if (!s?.brain) {
    text('scene-label', s?.phase === 'simulating' ? 'Neural simulation running' : 'Anatomy only · no activity yet');
    text(
      'scene-title',
      s?.phase === 'encoding'
        ? s.source === 'jev'
          ? 'Jev describes. The fly waits.'
          : 'Your inputs. The real network.'
        : s?.phase === 'simulating'
          ? 'The fly gets its signals.'
          : 'The fly gets the vote.',
    );
    text(
      'scene-subtitle',
      s?.phase === 'encoding'
        ? 'Thirty descriptive questions. No approve/reject question.'
        : s?.phase === 'simulating'
          ? 'Running the real connectivity. Activity appears once it is recorded.'
          : 'Sampled real neuron positions. Violet: Kenyon cells. Red and green rings: avoidance and approach MBONs. Pink rings: dopamine neurons, quiet until a lesson. The six larger rings are motor readouts; the green pair is the proboscis.',
    );
  } else if (inspectingAblation) {
    text('scene-label', 'Control trial · connections disabled');
    text('scene-title', 'Same signals. Connections off.');
    text('scene-subtitle', 'Input neurons can still spike. Watch whether anything reaches the six ringed readouts.');
  } else if (!revealed) {
    text('scene-label', elapsed < preambleMs() ? 'Neutral descriptors → odor' : 'Recorded activity · slowed playback');
    text(
      'scene-title',
      elapsed < preambleMs() ? 'Neutral descriptions become an odor.' : 'The fly model is responding.',
    );
    text(
      'scene-subtitle',
      elapsed < preambleMs()
        ? 'Signal routing is schematic. The neuron positions are real.'
        : 'Bright cells fired in this 25 ms window. Watch the ringed readouts.',
    );
  } else {
    text('scene-label', 'Recorded trial complete');
    text('scene-title', 'One network. One vote.');
    text(
      'scene-subtitle',
      'One odor, one memory. Violet cells carried the smell; red and green MBON rings answered; the pink dopamine rings stayed dark, because nothing was tasted. If the green proboscis readouts lit, the fly reached for it.',
    );
  }
  if (s?.verdict && hasVote) {
    const v = s.verdict.verdict;
    el('verdict').dataset.vote = v;
    if (s.attention) el('verdict').dataset.looked = '';
    else delete el('verdict').dataset.looked;
    text(
      'verdict-tag',
      s.attention
        ? `${flyName(s.brain!.seed)} · where it looked · ${changedRange(s.review)}`
        : `${flyName(s.brain!.seed)} · ${changedRange(s.review)}`,
    );
    const reached = s.verdict.behavior === 'reached';
    const voteTitle =
      v === 'changes_requested'
        ? 'Changes requested.'
        : v === 'no_objection'
          ? reached
            ? 'The fly reached for it.'
            : 'No objection.'
          : 'The fly abstains.';
    // On a pull request the headline is where it looked; the vote is its opinion of that one hunk, and usually it has
    // none, because its memory is executable functions, not pull requests.
    const lookedAt = s.attention?.units[s.attention.looked];
    if (lookedAt && s.attention) {
      const stood = standsOut(
        s.attention.units.map(u => u.reading),
        s.attention.looked,
      );
      const where = `${lookedAt.filename.split('/').pop()}${lookedAt.hunk === null ? '' : `, hunk ${lookedAt.hunk + 1}`}`;
      const vote =
        v === 'changes_requested'
          ? 'changes requested, it smells like something it tasted bitter with'
          : v === 'no_objection'
            ? reached
              ? 'it reached for it, the smell of a change that came with sugar'
              : 'no objection, its approach neurons lean toward it though it did not reach'
            : 'abstain, its memory leans neither way on this smell';
      text('verdict-title', stood.stands ? `Looked at ${where}.` : 'Nothing stood out.');
      text(
        'reviewer-comment',
        stood.stands
          ? `${s.attention.units.length} ${s.attention.granularity}s read twice; ${stood.quiet} went quiet, this one stayed loudest (${lookedAt.reading.noveltyHz.toFixed(0)} of ${lookedAt.reading.naiveNoveltyHz.toFixed(0)} Hz). Its vote on that ${s.attention.granularity}: ${vote}.`
          : `${s.attention.units.length} ${s.attention.granularity}s read twice, and ${stood.why}. Novelty only finds the one thing unlike the rest when the rest are alike; this diff has no repeated bulk to fade. Loudest, barely: ${where}. Its vote on that ${s.attention.granularity}: ${vote}.`,
      );
    } else {
      text('verdict-title', voteTitle);
      text('reviewer-comment', quip(reached ? QUIPS.reached : QUIPS[v], s.brain!.seed));
    }
    renderNearest(s);
    renderAttention(s);
    const note = el('channel-note');
    if (s.channels) {
      const rates = `avoid ${s.channels.mushroom.avoidHz.toFixed(0)} Hz · approach ${s.channels.mushroom.approachHz.toFixed(0)} Hz · share ${s.channels.mushroom.share.toFixed(2)}`;
      note.replaceChildren(
        Object.assign(document.createElement('b'), { textContent: rates }),
        document.createTextNode(` ${s.channels.summary}`),
      );
    } else note.textContent = '';
    text('readout-explanation', s.verdict.explanation);
    text(
      'score',
      `Proboscis (MN9) ${s.brain!.feedHz.toFixed(0)} Hz, reach line ${VERDICT_RULE.reachHz} · avoidance share ${s.verdict.score.toFixed(3)}, objection at ${VERDICT_RULE.objection}, approval at ${VERDICT_RULE.approval} · not a bug probability.`,
    );
    document
      .querySelectorAll('.diff-line.added')
      .forEach(line => line.classList.toggle('review-focus', v === 'changes_requested'));
  }
  text(
    'investigator-note',
    s?.review.pullRequest
      ? state?.hasGitHub
        ? 'No contract, so no test. The fly can leave this vote as a comment on the pull request.'
        : 'No contract, so no test. Set GITHUB_TOKEN or log in with gh to let the fly post its review.'
      : s?.review.oracle === null
        ? 'Pasted changes have no contract, so there is nothing to test against. Bundled examples only.'
        : s?.hasInvestigator || state?.hasInvestigator
          ? 'One live Claude call, blind to the contract and the vote. Then code executes.'
          : 'Set ANTHROPIC_API_KEY to enable the investigator.',
  );
  el('diff-shell').classList.toggle('scanning', s?.phase === 'encoding' && !reduce.matches);
  stamp(s, hasVote);
  el('verification-section').hidden = !hasVote || !(s?.verification || s?.phase === 'investigating');
  if (s?.phase === 'investigating') {
    text('receipt-title', 'Writing a test. Not asking another opinion.');
    text(
      'receipt-explanation',
      'Claude sees the diff and the caller context. Not the contract. Not the fly’s vote. It bets on one input; the runner executes both versions plus the deterministic sweep.',
    );
    text('receipt-status', 'Investigating');
  }
  el('receipt').hidden = !s?.verification;
  if (state?.poking) {
    text('headline', 'Poking the fly.');
    text(
      'explanation',
      'One sensory population, one real simulation, nothing to do with the code. Watch which readout answers.',
    );
  } else if (s?.phase === 'error') {
    text('headline', 'The experiment stopped.');
    text('explanation', s.explanation);
  } else if (s?.phase === 'encoding') {
    text('headline', s.source === 'jev' ? 'Jev is describing the change.' : 'Using your manual signals.');
    text(
      'explanation',
      s.source === 'jev'
        ? 'Thirty descriptive questions. No approve/reject question.'
        : 'No model is interpreting the code in this mode.',
    );
  } else if (s?.phase === 'simulating' || s?.phase === 'ablating') {
    text('headline', s.phase === 'ablating' ? 'Testing the network’s contribution.' : 'Running the neural simulation.');
    text('explanation', 'Measured data is on its way. The camera moving is not activity.');
  } else if (playing && !revealed) {
    text('headline', 'Watch the recorded response.');
    text('explanation', 'The computation is finished. This is a slow replay of its measured activity.');
  } else if (s?.phase === 'investigating') {
    text('headline', 'Testing the fly’s vote.');
    text('explanation', 'An independent AI bets on one input. The runner checks the original and changed code.');
  } else if (s?.verification) {
    text('headline', 'A verdict is not evidence.');
    text('explanation', 'The executed test result is below.');
  } else if (s?.posted && hasVote) {
    text('headline', 'The fly has left its review.');
    text('explanation', s.explanation);
  } else if (hasVote) {
    text(
      'headline',
      s?.review.pullRequest
        ? 'The fly has voted on your pull request.'
        : s?.review.oracle === null
          ? 'The fly has voted on your change.'
          : 'The fly has voted. Was it right?',
    );
    text(
      'explanation',
      s?.review.oracle === null
        ? 'No contract means no test. Pick a bundled example to see the vote put on trial, or ask another fly.'
        : 'A separate investigator will bet on one input. Ordinary code checks the claim.',
    );
  } else {
    text('headline', 'One diff. One fly. One questionable opinion.');
    text('explanation', 'Ask for a review, then put the verdict to a test.');
  }
}

/**
 * What a lesson means, said relative to the vote. Dopamine in the fly is a statement about the smell, not a grade for
 * the animal: it arrives whether or not the fly was right. The words say which of the three cases this was.
 */
function lessonWords(
  lesson: LessonEntry,
  verdict: 'changes_requested' | 'no_objection' | 'abstain' | undefined,
): { title: string; detail: string; agree: 'right' | 'wrong' | 'new' } {
  const punish = lesson.lesson === 'punish';
  const agree = punish
    ? verdict === 'changes_requested'
      ? 'right'
      : verdict === 'no_objection'
        ? 'wrong'
        : 'new'
    : verdict === 'no_objection'
      ? 'right'
      : verdict === 'changes_requested'
        ? 'wrong'
        : 'new';
  const title = punish
    ? {
        right: 'Confirmed: this smell preceded a real break.',
        wrong: 'Corrected: it leaned into a smell that broke things.',
        new: 'Learned: this smell preceded a real break.',
      }[agree]
    : {
        right: 'Confirmed: a known-harmless control smells like this.',
        wrong: 'Corrected: it backed away from a known-harmless control.',
        new: 'Learned: a known-harmless control smells like this.',
      }[agree];
  const framing = {
    right: `The fly ${punish ? 'backed away' : 'leaned in'} and the test agreed. The taste is about the smell, not a grade for the fly: it arrives whether or not the fly was right, and here it deepened a memory the fly already had.`,
    wrong: `The fly ${punish ? 'raised no objection' : 'requested changes'} and the test disagreed. Next time it smells this, it should ${punish ? 'back away' : 'lean in'}.`,
    new: 'The fly had no opinion about this smell. Now it has a lesson to test.',
  }[agree];
  const t = lesson.teaching;
  const mechanism = t
    ? `${punish ? 'Bitter' : 'Sugar'} on its proboscis while it smelled this: its ${punish ? `PPL1 dopamine neurons fired at ${t.ppl1Hz.toFixed(0)} Hz` : `PAM dopamine neurons fired at ${t.pamHz.toFixed(0)} Hz`}${!punish && t.feedHz > 0 ? ` and its proboscis came out (MN9 ${t.feedHz.toFixed(0)} Hz)` : ''}. ${lesson.depressed.toLocaleString()} synapses of the ${lesson.activeKenyon} Kenyon cells carrying the odor were depressed where that dopamine landed: ${punish ? `${t.byGroup.approach.toLocaleString()} onto approach MBONs, ${t.byGroup.avoid.toLocaleString()} onto avoidance` : `${t.byGroup.avoid.toLocaleString()} onto avoidance MBONs, ${t.byGroup.approach.toLocaleString()} onto approach`}. The wiring chose those compartments, not us.`
    : `${lesson.activeKenyon} Kenyon cells carried this odor; ${lesson.depressed.toLocaleString()} of their synapses onto ${punish ? 'approach' : 'avoidance'} MBONs were depressed.`;
  const detail = `${lesson.reason} ${mechanism} ${framing} ${lesson.rememberedSynapses.toLocaleString()} synapses now carry memory. Ask it again and compare the measured share; forget everything and the memory’s effect is gone.`;
  return { title, detail, agree };
}

function render(s: ReviewState) {
  const first = state === null;
  state = s;
  if (first) {
    boundRun = s.runDir;
    selected = s.review.id;
    // A lesson already on the books when the page opens is history: show the vote, not the teaching trial.
    knownTeaching = s.lesson?.at ?? null;
    if (s.review.pullRequest) {
      pullRequestPreview = s.review;
      el<HTMLInputElement>('pr-url').value = s.review.pullRequest.url;
    } else if (s.review.custom) fillCustomForm(s.review);
    el<HTMLSelectElement>('example').value = selected;
    if (s.hasJev) {
      mode = 'jev';
      el<HTMLInputElement>('jev-mode').checked = true;
    }
    renderDiff();
  }
  if (awaitingRun && s.runDir !== previousRun && s.review.id === selected) {
    boundRun = s.runDir;
    awaitingRun = false;
  }
  const a = active();
  if (!a && recording && playbackKind !== 'poke') clearRecording();
  el('api-notice').hidden = s.hasJev;
  el<HTMLInputElement>('jev-mode').disabled = !s.hasJev || s.busy;
  el<HTMLInputElement>('manual-mode').disabled = s.busy;
  el<HTMLSelectElement>('example').disabled = s.busy;
  document.querySelectorAll('.diff-line.added').forEach(line => line.classList.toggle('scan', a?.phase === 'encoding'));
  text('connection', connected ? 'Connected · live experiment' : 'Disconnected · reconnecting');
  text(
    'provenance',
    a?.source === 'jev'
      ? `Live ${a.encoderModel ?? 'Jev'} · real connectome`
      : a?.source === 'manual'
        ? 'Manual inputs · real connectome · no Jev call'
        : 'Live Jev → real neural simulation → independent test',
  );
  renderRecord(s);
  renderMemory(s);
  if (a?.brain && s.runDir !== knownRun) {
    knownRun = s.runDir;
    knownAblation = a.ablation;
    play(a.brain, 'original');
  }
  if (a?.ablation && !knownAblation) {
    knownAblation = a.ablation;
    play(a.ablation, 'disconnected');
  }
  // A lesson is a recorded trial too: play it once when it lands, so the dopamine neurons can be watched firing.
  if (a?.teaching && a.lesson && a.lesson.at !== knownTeaching) {
    knownTeaching = a.lesson.at;
    play(a.teaching, 'lesson');
  } else if (!a?.teaching) knownTeaching = null;
  if (s.poke && s.poke.at !== knownPoke) {
    knownPoke = s.poke.at;
    play(s.poke.brain, 'poke');
  }
  reviewer.lock(s.busy || !connected);
  for (const button of document.querySelectorAll<HTMLButtonElement>('#poke-buttons button'))
    button.disabled = s.busy || !connected;
  el('comparison').hidden = !a?.ablation;
  if (a?.ablation && a.brain) {
    const before = a.brain.feedHz + a.brain.groomHz + a.brain.escapeHz,
      after = a.ablation.feedHz + a.ablation.groomHz + a.ablation.escapeHz;
    text(
      'comparison-title',
      before > 0 && after === 0
        ? 'The inputs arrived. The verdict disappeared.'
        : 'Connections disabled. Here is what changed.',
    );
    text(
      'comparison-detail',
      before > 0 && after === 0
        ? 'Same signals and seed. Switching off synaptic transmission silenced all six readout neurons. The network participated; that is all this shows.'
        : `Original downstream total: ${before} Hz. Disconnected total: ${after} Hz. A silent original or surviving output needs a different explanation.`,
    );
  }
  text(
    'repeat-result',
    a?.repeat
      ? a.repeat.identical
        ? 'Fresh simulation reproduced the rates, time bins, sampled positions, and activity. Only compute time was excluded.'
        : 'The fresh simulation differed. This trial is not reproducible.'
      : '',
  );
  if (a?.verification) {
    const r = a.verification,
      target = r.counterexample ?? r.runs[0],
      vote = a.verdict?.verdict;
    text('receipt-status', r.status.toUpperCase());
    text(
      'receipt-title',
      r.status === 'confirmed'
        ? vote === 'changes_requested'
          ? 'This objection checks out.'
          : vote === 'abstain'
            ? 'The test found a bug after abstention.'
            : 'The fly missed a real bug.'
        : r.status === 'unsubstantiated'
          ? 'We couldn’t substantiate a defect.'
          : 'The evidence is inconclusive.',
    );
    text(
      'receipt-explanation',
      r.status === 'confirmed'
        ? 'The same valid input passes before the change and fails after it. That is a reproduced regression.'
        : r.explanation,
    );
    text('test-input', formatReviewInput(a.review, target.args));
    document.querySelector<HTMLElement>('.test-results')!.dataset.format = a.review.format;
    text('test-expected', formatReviewValue(a.review, target.expected));
    text('test-before', target.before.error ?? formatReviewValue(a.review, target.before.value));
    text('test-after', target.after.error ?? formatReviewValue(a.review, target.after.value));
    for (const [name, result] of [
      ['before', target.before],
      ['after', target.after],
    ] as const) {
      const passed = !result.error && result.value === target.expected;
      el(`${name}-result`).className = passed ? 'pass' : 'fail';
      text(`${name}-pass`, passed ? 'PASS' : 'FAIL');
    }
    const attribution = el('attribution');
    attribution.className = `attribution ${r.probeFoundRegression ? 'blind' : r.status === 'confirmed' ? 'missed' : ''}`;
    text(
      'attribution',
      r.status === 'confirmed'
        ? r.probeFoundRegression
          ? `${r.model} found it blind: its one input exposed the regression without ever seeing the contract.${r.sweepFoundRegression ? ' The deterministic sweep found it too.' : ''}`
          : `${r.model} bet on ${a.review.functionName}(${r.probe.args.map(arg => JSON.stringify(arg)).join(', ')}) and missed. The deterministic sweep exposed the regression.`
        : r.status === 'unsubstantiated'
          ? `Neither ${r.model}’s input nor the ${r.runs.length - 1}-case sweep exposed a regression.`
          : 'The original code failed its own contract, so no regression can be attributed.',
    );
    text(
      'coverage',
      `${r.runs.length} executed cases: one AI-proposed input and ${r.runs.length - 1} case-specific deterministic cases. No demonstrated defect is not proof of correctness.`,
    );
    // What the outcome taught the fly. Only a reproduced regression or a designated control teaches anything.
    const lesson = a.lesson;
    const words = lesson ? lessonWords(lesson, a.verdict?.verdict) : null;
    el('lesson').dataset.lesson = lesson?.lesson ?? 'none';
    if (words) el('lesson').dataset.agree = words.agree;
    else delete el('lesson').dataset.agree;
    text(
      'lesson-title',
      words
        ? words.title
        : r.status === 'unsubstantiated' && !a.review.control
          ? 'The fly learned nothing from this.'
          : r.status === 'inconclusive'
            ? 'The fly learned nothing from this.'
            : a.phase === 'error'
              ? 'Teaching was interrupted.'
              : 'Waiting for the lesson…',
    );
    text(
      'lesson-detail',
      words
        ? words.detail
        : r.status === 'unsubstantiated'
          ? 'No regression was found, but that is not proof of correctness, and this change is not a designated behavior-preserving control. Unknown stays unknown, so nothing was taught.'
          : r.status === 'inconclusive'
            ? 'The original failed its own contract; nothing can be attributed, so nothing was taught.'
            : a.phase === 'error'
              ? `${a.explanation} The receipt in this run’s lesson folder says whether the memory was committed before the interruption.`
              : 'The outcome is being paired with this odor.',
    );
    el<HTMLButtonElement>('recall').hidden = !a.brain;
    text('test-code', r.testCode);
    text(
      'probe-detail',
      `${r.model} proposed ${a.review.functionName}(${r.probe.args.map(arg => JSON.stringify(arg)).join(', ')}), expecting ${JSON.stringify(r.probe.expected)}, without the contract. Unverified rationale: ${r.probe.rationale}`,
    );
    text(
      'model-expectation',
      r.modelExpectedCorrect
        ? 'The proposed expected value matched the independent contract.'
        : 'The AI’s expected value disagreed with the contract. The runner used the contract.',
    );
    if (pendingVerification) {
      pendingVerification = false;
      requestAnimationFrame(() =>
        el('verification-section').scrollIntoView({
          behavior: reduce.matches ? 'instant' : 'smooth',
          block: 'nearest',
        }),
      );
    }
  }
  el('log').replaceChildren(
    ...(a?.log ?? []).map(entry => {
      const li = document.createElement('li'),
        time = document.createElement('time');
      time.textContent = new Date(entry.at).toLocaleTimeString('en-US', { hour12: false });
      li.append(time, document.createTextNode(entry.text));
      return li;
    }),
  );
  text(
    'evidence',
    a?.runDir
      ? `Saved evidence: ${a.runDir}/review.json, events.jsonl, ${a.review.pullRequest ? 'pull-request.json, pull-request.diff' + (a.posted ? ', github-review.md' : '') : a.review.filename}${a.review.oracle === null ? '.' : ', and regression.test.ts after investigation.'}`
      : 'No review has run for this selection.',
  );
  if (s.phase === 'error') {
    text('error', s.explanation);
    el('error').hidden = false;
    pendingVerification = false;
  }
  renderFeatures();
  updateStory();
  // Listeners run last so getters (state, active run) already reflect this event.
  for (const listener of stateListeners) listener(s);
}

async function request(body: ReviewAction) {
  el('error').hidden = true;
  try {
    const response = await fetch('/api/review/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  } catch (error) {
    text('error', String(error));
    el('error').hidden = false;
    pendingVerification = false;
    presenting = false;
  }
}
/** Drive the drawing and its labels from measured rates: per-bin during playback, the 250 ms mean once revealed. */
function showReviewer(
  reading: { feedHz: number; groomHz: number; escapeHz: number; avoidHz?: number; approachHz?: number } | null,
  frame: ReviewFrame | null,
  input: number,
) {
  const feed = reading ? reading.feedHz / 90 : 0,
    groom = reading ? reading.groomHz / 200 : 0,
    escape = reading ? reading.escapeHz / 480 : 0;
  const avoidHz = reading?.avoidHz ?? 0,
    approachHz = reading?.approachHz ?? 0,
    mbTotal = avoidHz + approachHz;
  // The mushroom body's balance drives posture: how far above or below even the share sits, scaled to 0..1.
  const share = mbTotal >= 20 ? avoidHz / mbTotal : 0.5;
  const avoid = Math.max(0, (share - 0.5) / 0.5),
    approach = Math.max(0, (0.5 - share) / 0.5);
  const drive = { feed, groom, escape, input: reading ? input * 0.5 : input, approach, avoid };
  reviewer.drive(flyOverride ? { ...drive, ...flyOverride } : drive);
  const what = behavior(feed, groom, escape, Boolean(reading && (recording?.stimuli?.bitter ?? 0) > 0));
  text('legend-rate-mb', reading && mbTotal >= 20 ? `${avoidHz.toFixed(0)} / ${approachHz.toFixed(0)} Hz` : '—');
  text('legend-doing-mb', reading ? mushroomReading(avoidHz, approachHz) : 'mushroom body quiet');
  // The teaching neurons: quiet in a review, firing only while a taste is on the tongue during a lesson.
  const ppl1 = reading ? (frame?.ppl1Hz ?? recording?.ppl1Hz ?? 0) : 0,
    pam = reading ? (frame?.pamHz ?? recording?.pamHz ?? 0) : 0;
  text('legend-rate-dan', reading && (ppl1 >= 1 || pam >= 1) ? `${ppl1.toFixed(0)} / ${pam.toFixed(0)} Hz` : '—');
  // Only a lesson trial delivers a taste. In an ordinary review the PPL1 cells still answer the odor a little, because
  // Kenyon cells synapse onto them; with no taste there is no plasticity, so that is a response, not teaching.
  const lesson = recording?.lesson ?? 'none';
  text(
    'legend-doing-dan',
    lesson === 'punish' && ppl1 >= 20
      ? 'punishment neurons firing: bitter'
      : lesson === 'reward' && pam >= 20
        ? 'reward neurons firing: sugar'
        : ppl1 >= 1 || pam >= 1
          ? 'answering the smell, no taste, no lesson'
          : 'teaching neurons quiet',
  );
  el('legend-dan').classList.toggle(
    'firing',
    lesson !== 'none' &&
      (Boolean(frame?.danCounts?.some(counts => counts.some(n => n > 0))) || (!frame && (ppl1 >= 20 || pam >= 20))),
  );
  el('legend-mb').classList.toggle(
    'firing',
    Boolean(frame?.mbonCounts?.some(counts => counts.some(n => n > 0))) || (!frame && mbTotal >= 20),
  );
  const rates = reading ? [reading.feedHz, reading.groomHz, reading.escapeHz] : null;
  channelIds.forEach((suffix, i) => {
    text(`legend-rate-${suffix}`, rates ? `${rates[i].toFixed(0)} Hz` : '—');
    text(`legend-doing-${suffix}`, [what.a, what.b, what.c][i]);
    el(`legend-${suffix}`).classList.toggle(
      'firing',
      Boolean(frame?.readoutCounts?.[i]?.some(n => n > 0)) || (!frame && Boolean(rates && rates[i] > 0)),
    );
  });
  text(
    'reviewer-summary',
    reading
      ? mbTotal >= 20 && feed <= 0 && groom <= 0 && escape <= 0
        ? mushroomReading(avoidHz, approachHz)
        : what.summary
      : input > 0
        ? 'Stimulated. Signals are arriving at the sensory neurons; nothing downstream has fired yet.'
        : what.summary,
  );
}

function clearRecording() {
  recording = null;
  playing = false;
  revealed = false;
  elapsed = 0;
  view.setActivity(emptyActivity);
  view.setReadoutActivity(null);
  view.setMushroomActivity(null, null, null);
  view.focusReadout(null);
  el('stamp').hidden = true;
  el('diff-shell').classList.remove('scanning');
  for (const id of ['verdict', 'comparison', 'verification-section']) el(id).hidden = true;
  for (const suffix of channelIds) {
    el<HTMLMeterElement>(`output-${suffix}`).value = 0;
    text(`rate-${suffix}`, '—');
  }
  showReviewer(null, null, 0);
  reviewer.poked(null);
  el<HTMLButtonElement>('pause').disabled = true;
  el<HTMLInputElement>('scrub').disabled = true;
  el<HTMLInputElement>('scrub').value = '0';
  text('neural-time', 'No recording yet');
  text('recording-note', '');
  text('provenance', 'No review has run for this selection.');
  text('test-code', 'Run an independent investigation to generate a test.');
  text('probe-detail', '');
  text('model-expectation', '');
  text('readout-explanation', '');
  text('score', '');
  text('repeat-result', '');
  text('evidence', 'No review has run for this selection.');
  text('attribution', '');
  el('log').replaceChildren();
  uiStamp = '';
}
function resetSelection() {
  boundRun = null;
  awaitingRun = false;
  pendingVerification = false;
  presenting = false;
  clearRecording();
  renderDiff();
  renderFeatures();
  updateStory();
}

function beginRun() {
  previousRun = state?.runDir ?? null;
  boundRun = null;
  awaitingRun = true;
  presenting = true;
  knownRun = null;
  knownAblation = null;
  knownTeaching = null;
  clearRecording();
  if (narrow()) el('neural').scrollIntoView({ behavior: reduce.matches ? 'instant' : 'smooth', block: 'center' });
}
el('review').addEventListener('click', async () => {
  if (!mode || preparingReview) return;
  let custom: ReturnType<typeof customInput> | undefined, pullRequest: string | undefined;
  if (selected === CUSTOM_CASE_ID) {
    custom = customInput();
    try {
      customReviewCase(custom);
    } catch (error) {
      text('error', String(error));
      el('error').hidden = false;
      return;
    }
  }
  if (selected === PULL_REQUEST_CASE_ID) {
    if (!pullRequestPreview?.pullRequest) return;
    pullRequest = pullRequestPreview.pullRequest.url;
  }
  const body: Extract<ReviewAction, { action: 'review' }> = {
    action: 'review',
    caseId: selected,
    mode,
    ...(mode === 'manual' ? { features: structuredClone(manual) } : {}),
    ...(custom ? { custom } : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
  preparingReview = true;
  try {
    if (mode === 'jev' && (custom || pullRequest)) {
      const disclosure = await confirmCodeDisclosure(body);
      if (!disclosure) return;
      if (
        body.caseId !== selected ||
        body.mode !== mode ||
        (custom && JSON.stringify(custom) !== JSON.stringify(customInput())) ||
        (pullRequest && pullRequest !== pullRequestPreview?.pullRequest?.url)
      ) {
        throw new Error('The selection changed while disclosure was open. Review and acknowledge the new payload.');
      }
      body.disclosure = disclosure;
    }
    beginRun();
    await request(body);
  } catch (error) {
    text('error', String(error));
    el('error').hidden = false;
  } finally {
    preparingReview = false;
  }
});
el('recall').addEventListener('click', () => {
  if (!active()?.brain) return;
  beginRun();
  void request({ action: 'recall' });
});
el('forget').addEventListener('click', () => {
  if (
    !confirm(
      'Forget everything the tests have taught this fly? The wiring stays; only the learned synapse strengths reset.',
    )
  )
    return;
  void request({ action: 'reset-memory' });
});
el('second-opinion').addEventListener('click', () => {
  if (!active()?.brain) return;
  beginRun();
  void request({ action: 'second-opinion' });
});
el('post-review').addEventListener('click', () => {
  const pr = active()?.review.pullRequest;
  if (!pr) return;
  if (
    !confirm(
      `Post the fly’s vote as a comment-only review on ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}? Everyone on that pull request will see it.`,
    )
  )
    return;
  void request({ action: 'post-review' });
});
function poke(preset: PokePreset) {
  if (state?.busy || !connected) return;
  // React on the click itself: the organ lights up and the sensory drive shows before the simulation returns.
  reviewer.poked(preset);
  showReviewer(null, null, 0.8);
  text(
    'reviewer-summary',
    `${POKE_PRESETS[preset].label}: ${POKE_PRESETS[preset].population}. Simulating what reaches the readouts.`,
  );
  void request({ action: 'poke', stimuli: { [preset]: DEFAULT_POKE_HZ } });
}
reviewer.onPoke = poke;
for (const name of POKE_NAMES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = POKE_PRESETS[name].label;
  button.title = `${POKE_PRESETS[name].population}. In a living fly: ${POKE_PRESETS[name].expect}.`;
  button.addEventListener('click', () => poke(name));
  el('poke-buttons').append(button);
}
el('pr-fetch').addEventListener('click', () => void fetchPullRequestPreview());
el('pr-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void fetchPullRequestPreview();
  }
});
el('pr-url').addEventListener('input', () => {
  previewRequest?.abort();
  previewRequest = null;
  fetchingPr = false;
  el<HTMLButtonElement>('pr-fetch').disabled = false;
  pullRequestPreview = null;
  text('pr-status', 'Input changed. Fetch this pull request before reviewing.');
  resetSelection();
});
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))
  input.addEventListener('change', () => {
    mode = input.value as 'jev' | 'manual';
    renderFeatures();
  });
el('manual-shortcut').addEventListener('click', () => {
  el<HTMLDetailsElement>('inspect').open = true;
  mode = 'manual';
  el<HTMLInputElement>('manual-mode').checked = true;
  renderFeatures();
  el('features').scrollIntoView({ behavior: reduce.matches ? 'instant' : 'smooth', block: 'center' });
});
const customReviewCaseOrNull = (input: ReturnType<typeof customInput>) => {
  try {
    return customReviewCase(input);
  } catch {
    return null;
  }
};
el('example').addEventListener('change', () => {
  selected = el<HTMLSelectElement>('example').value;
  if (selected === CUSTOM_CASE_ID && state?.review.custom && !state.review.pullRequest) {
    const input = customInput();
    if (!input.before && !input.after) fillCustomForm(state.review);
  }
  if (selected === PULL_REQUEST_CASE_ID && state?.review.pullRequest && !pullRequestPreview) {
    pullRequestPreview = state.review;
    el<HTMLInputElement>('pr-url').value = state.review.pullRequest.url;
  }
  resetSelection();
  // Switching back to the change the server last ran rebinds that run, as long as a pasted change or fetched pull request is the same one.
  const sameContent =
    selected === CUSTOM_CASE_ID
      ? JSON.stringify(customReviewCaseOrNull(customInput())) === JSON.stringify(state?.review)
      : selected === PULL_REQUEST_CASE_ID
        ? Boolean(
            pullRequestPreview?.pullRequest && pullRequestPreview.pullRequest.url === state?.review.pullRequest?.url,
          )
        : true;
  if (state?.runDir && state.review.id === selected && sameContent) {
    boundRun = state.runDir;
    knownRun = null;
    knownAblation = null;
    knownTeaching = null;
    render(state);
  }
  if (selected === CUSTOM_CASE_ID) el<HTMLTextAreaElement>('custom-before').focus();
  if (selected === PULL_REQUEST_CASE_ID && !pullRequestPreview) el<HTMLInputElement>('pr-url').focus();
});
for (const id of customFields)
  el(id).addEventListener('input', () => {
    if (selected === CUSTOM_CASE_ID) resetSelection();
  });
el('verify').addEventListener('click', () => {
  pendingVerification = true;
  void request({ action: 'verify' });
});
el('disconnect').addEventListener('click', () => void request({ action: 'disconnect' }));
el('repeat').addEventListener('click', () => void request({ action: 'repeat' }));
for (const id of ['replay', 'play-original'])
  el(id).addEventListener('click', () => {
    const brain = active()?.brain;
    if (brain) play(brain, 'original');
  });
el('pause').addEventListener('click', () => {
  if (elapsed >= totalMs()) elapsed = 0;
  playing = !playing;
  uiStamp = '';
  updateStory();
});
el('scrub').addEventListener('input', () => {
  playing = false;
  frameIndex = Number(el<HTMLInputElement>('scrub').value);
  elapsed = preambleMs() + frameIndex * binMs();
  if (frameIndex === 9 && playbackKind === 'original') revealed = true;
  uiStamp = '';
  updateStory();
});
el('rotate').addEventListener('click', () => {
  view.rotating = !view.rotating;
  updateRotation();
});
el('reset-view').addEventListener('click', () => view.resetView());
function updateRotation() {
  el<HTMLButtonElement>('reset-view').disabled = view.renderer !== 'webgl';
  el<HTMLButtonElement>('rotate').disabled = reduce.matches || view.renderer !== 'webgl';
  text('rotate', view.rotating && !reduce.matches ? 'Pause orbit' : 'Rotate view');
  el('rotate').setAttribute('aria-pressed', String(view.rotating && !reduce.matches));
}
el('sound').addEventListener('click', () => {
  sounding = !sounding;
  text('sound', sounding ? 'Sound on' : 'Sound off');
  el('sound').setAttribute('aria-pressed', String(sounding));
  if (sounding) chime();
});
el('copy-test').addEventListener('click', async () => {
  const r = active()?.verification;
  if (!r) return;
  try {
    await navigator.clipboard.writeText(r.testCode);
    text('copy-test', 'Copied');
  } catch {
    el<HTMLDetailsElement>('inspect').open = true;
    el('test-code').scrollIntoView({ block: 'center' });
    text('copy-test', 'Select the test below to copy');
  }
});
el('explain').addEventListener('click', () => el<HTMLDialogElement>('explanation-dialog').showModal());

const experiments = initExperiments({
  state: active,
  latest: () => state,
  request,
  recall: () => {
    if (!active()?.brain) return;
    beginRun();
    void request({ action: 'recall' });
  },
  pokeSugar: () => poke('sugar'),
});
stateListeners.add(() => experiments.render());
const tour = new Walkthrough({
  state: () => state,
  onState: listener => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  focusMushroomBody: on => {
    view.emphasizeMushroomBody = on;
    view.focusMushroomBody(on);
  },
  leanFly: drive => {
    flyOverride = drive;
    if (drive) reviewer.drive({ feed: 0, groom: 0, escape: 0, input: 0, ...drive });
    else showReviewer(recording && revealed ? recording : null, null, 0);
  },
  askTheFly: () => el<HTMLButtonElement>('review'),
  control: id => document.getElementById(id) as HTMLButtonElement | null,
  readiness: () => el('billing').textContent ?? '',
});
el('tour').addEventListener('click', () => tour.start(0));
// Open the page at #tour (or #tour-3) to start the walkthrough at load, for a talk or a link.
if (/^#tour(-\d+)?$/.test(location.hash)) {
  const at = Number(location.hash.split('-')[1] ?? 0);
  setTimeout(() => tour.start(at), 900);
}
el('tour-verdict').addEventListener('click', () => tour.start(3));
el('close-explanation').addEventListener('click', () => el<HTMLDialogElement>('explanation-dialog').close());

function draw(now: number) {
  const delta = lastAnimation ? Math.min(100, now - lastAnimation) : 0;
  lastAnimation = now;
  if (playing) elapsed += delta;
  if (recording && (playbackKind === 'poke' || active()?.brain)) {
    frameIndex = Math.max(0, Math.min(9, Math.floor((elapsed - preambleMs()) / binMs())));
    if (elapsed >= totalMs() && playing) {
      playing = false;
      if (playbackKind === 'original') {
        revealed = true;
        chime();
      }
      updateStory();
      presentVote();
    }
    const frame = recording.frames[frameIndex];
    const showing = elapsed >= preambleMs();
    view.setActivity(showing ? (frame.activity3d ?? emptyActivity) : emptyActivity);
    view.setReadoutActivity(showing ? (frame.readoutCounts ?? null) : null);
    view.setMushroomActivity(
      showing ? (frame.kenyonActive3d ?? null) : null,
      showing ? (frame.mbonCounts ?? null) : null,
      showing ? (frame.danCounts ?? null) : null,
    );
    if (showing && playing && frameIndex !== lastSoundFrame) {
      lastSoundFrame = frameIndex;
      crackle(frame, Math.max(...recording.frames.map(f => f.spikes)));
    }
    const stamp = `${knownRun}/${playbackKind}/${frameIndex}/${revealed}/${playing}/${showing}`;
    if (stamp !== uiStamp) {
      uiStamp = stamp;
      el<HTMLInputElement>('scrub').value = String(frameIndex);
      const final = revealed && !playing && playbackKind === 'original',
        reading = final ? recording : frame;
      const rates = [reading.feedHz, reading.groomHz, reading.escapeHz];
      channelIds.forEach((suffix, i) => {
        el<HTMLMeterElement>(`output-${suffix}`).value = showing ? rates[i] : 0;
        text(`rate-${suffix}`, showing ? `${rates[i].toFixed(0)} Hz` : '—');
      });
      // Before the signals arrive the fly only feels the stimulation; once the bins play, its body follows the readouts.
      const inputDrive =
        recording.rates.reduce((a, b) => a + b, 0) /
        (recording.rates.length * (pokedPreset(recording.stimuli) ? 200 : 180));
      showReviewer(showing ? reading : null, showing ? frame : null, inputDrive);
      reviewer.poked(!final ? pokedPreset(recording.stimuli) : null);
      text(
        'neural-time',
        !showing ? 'Input signals' : final ? '250 ms mean' : `${frame.timeMs - 25}–${frame.timeMs} ms`,
      );
      text(
        'recording-note',
        `${playbackKind === 'disconnected' ? 'Disconnected' : playbackKind === 'poke' ? 'Poke' : playbackKind === 'lesson' ? 'Teaching' : 'Original'} trial: ${recording.spikes.toLocaleString()} spikes over 450 ms, ${recording.wallMs.toFixed(0)} ms compute. Bins of 25 ms from 200–450 ms, about ${Math.round(binMs() / 25)}× slower.${frame.readoutCounts ? '' : ' Legacy recording: rerun for readout activity.'}`,
      );
      updateStory();
    }
  }
  view.draw(now, reduce.matches, playbackKind === 'disconnected' && Boolean(recording));
  requestAnimationFrame(draw);
}
reduce.addEventListener('change', () => {
  view.rotating = !reduce.matches;
  if (reduce.matches && recording) {
    elapsed = totalMs();
    frameIndex = 9;
    playing = false;
    if (playbackKind === 'original') revealed = true;
    uiStamp = '';
    updateStory();
    presentVote();
  }
  updateRotation();
});
void fetch('/anatomy.json')
  .then(async response => {
    if (!response.ok) throw new Error('Run npm run setup to generate the actual 3D anatomy.');
    return response.json() as Promise<BrainAnatomy>;
  })
  .then(loaded => {
    anatomy = loaded;
    view.setAnatomy(anatomy);
    text(
      'geometry-note',
      `${anatomy.geometry3d.length.toLocaleString()} sampled neuron-body positions and ${anatomy.links3d.length.toLocaleString()} real connections are displayed; the full network runs in the simulator. Bright points are measured firing. The ${anatomy.readouts3d ? anatomy.readouts3d.flat().length : 'six'} larger ringed cells are the readout neurons at their real positions; the small rings are MBONs (red avoidance, green approach) and dopamine neurons (pink), all at theirs. Camera movement is not activity.`,
    );
    if (!anatomy.readouts3d) {
      text('anatomy-error', 'Readout neuron positions are missing. Run npm run setup again to export them.');
      el('anatomy-error').hidden = false;
    }
    updateRotation();
    updateStory();
  })
  .catch(error => {
    text('anatomy-error', String(error));
    el('anatomy-error').hidden = false;
  });
const stream = new EventSource('/review-events');
stream.onopen = () => {
  connected = true;
  if (state) render(state);
};
stream.onmessage = event => render(JSON.parse(event.data) as ReviewState);
stream.onerror = () => {
  connected = false;
  text('connection', 'Disconnected · reconnecting');
  if (state) render(state);
};
renderDiff();
renderFeatures();
updateRotation();
requestAnimationFrame(draw);

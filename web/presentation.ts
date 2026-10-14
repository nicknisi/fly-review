import { BrainView } from './brain-view.js';
import { FlyModel, SABER_BPM } from './fly-model.js';
import { doom } from './doom.js';
import { PULL_REQUEST_CASE_ID, parsePatch } from '../src/review-cases.js';
import type { ReviewCase } from '../src/review-cases.js';
import { reviewUnits } from '../src/review-hunks.js';
import type { BrainAnatomy, ReviewFrame } from '../src/review-brain.js';
import type { ReviewState } from '../src/review-types.js';

/**
 * The talk deck at /presentation. Every number comes from /deck.json (npm run deck, generated from the measured record);
 * every brain you see is a real recording of the simulator, played back. Slide text is facts and Nick's own words.
 */
type Frame = Omit<ReviewFrame, 'inputSpikes' | 'activity'>;
type Shown = { id: string; title: string; filename: string; diff: { kind: string; text: string }[] };
type Recording = {
  lesson: string;
  verdict: string;
  behavior: string;
  feedHz: number;
  avoidHz: number;
  approachHz: number;
  ppl1Hz: number;
  pamHz: number;
  activeKenyon: number;
  shuffle: string | null;
  stimuli: Record<string, number>;
  frames: Frame[];
  note: string;
  review: Shown | null;
};
type Pick = Shown & {
  label: 'bug' | 'fine';
  smell: string | null;
  fly: { verdict: string; share: number; behavior: string };
};
type Numbers = {
  neurons: number;
  connections: number;
  kenyonCells: number;
  rate: number;
  passes: number;
  plasticSynapses: number;
  glomeruli: number;
  lessons: number;
  heldOut: number;
  balanced: number;
  agree: number;
  caught: [number, number];
  approved: [number, number];
  falseAlarms: number;
  bugsApproved: number;
  abstained: number;
  votes: number;
  naiveAgree: number;
  bundled: { agree: number; judged: number };
  logisticAgree: number;
  shuffled: { caught: [number, number]; bugsApproved: number };
  answerKey: Record<string, { single: number; glomerulus: string; logistic: number; fly: number | null }>;
  prs: { pr: string; title: string; verdict: string; share: number; looked: string | null }[];
  intent: {
    tickets: number;
    rightApproved: [number, number];
    rightObjected: number;
    wrongCaught: [number, number];
    sameVerdict: number;
    balanced: number;
    spreadsheetBalanced: number;
    spreadsheetRightApproved: [number, number];
    refactorsApproved: [number, number];
    refactorsObjected: number;
    prCode: { total: number; approved: number; objected: number };
  };
};
type Deck = {
  numbers: Numbers;
  receptors: { key: string; label: string; question: string; silenced: boolean }[];
  recordings: Record<string, Recording>;
  pool: Pick[];
  poolRule: string;
  /** The harder test's example ticket: the right and the wrong change, with the fly's recorded vote on each. */
  intentExample: (Shown & { kind: 'right' | 'wrong'; fly: { verdict: string; share: number } })[];
};
type Slide = {
  id: string;
  minutes: string;
  className?: string;
  steps?: number;
  /** The premise, before the fly is plugged in: no brain, no fly. */
  bare?: boolean;
  build: (host: HTMLElement) => void;
  enter?: (step: number) => void;
  notes: string[];
};

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const html = (host: HTMLElement, markup: string) => host.insertAdjacentHTML('beforeend', markup);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

// The stage: the real brain, and the fly in its corner.
const view = new BrainView(el<HTMLCanvasElement>('brain'), () => {});
view.rotating = !reduce.matches;
let fly: FlyModel | null = null;
try {
  fly = new FlyModel(el('fly'));
} catch {
  el('fly').hidden = true;
}
const rest = { feed: 0, groom: 0, escape: 0, input: 0, approach: 0, avoid: 0, arousal: 0, smell: 0, dopamine: 0 };
/** The deck's resting camera. The canvas itself is shifted right in CSS so the brain sits beside the text, not behind it. */
const home = () => view.aim([0, 0, 0], 2.9);
let override: Partial<typeof rest> | null = null;
let lastDrive = rest;
const drive = (d: typeof rest) => {
  lastDrive = d;
  fly?.drive(override ? { ...d, ...override } : d);
};
/** A startle laid over whatever the recording is driving: wings up, body braced, for a moment. */
function flinch() {
  override = { ...override, escape: 0.5, arousal: 1 };
  drive(lastDrive);
  setTimeout(() => {
    override = null;
    drive(lastDrive);
  }, 170);
}

type Playback = { recording: Recording; started: number; binMs: number; loop: boolean; peak: number };
let playing: Playback | null = null;
/** What the slide was playing before the fly was touched; it resumes when the touch's recording ends. */
let resume: Playback | null | undefined;
let shownFrame = -1;
const playback = (recording: Recording, binMs: number, loop: boolean): Playback => ({
  recording,
  started: performance.now(),
  binMs: reduce.matches ? 0 : binMs,
  loop,
  peak: Math.max(1, ...recording.frames.map(f => f.spikes)),
});
function play(name: string, loop = true) {
  const recording = deck.recordings[name];
  if (!recording) return;
  resume = undefined;
  el('touch').classList.remove('on');
  playing = playback(recording, 420, loop);
  shownFrame = -1;
}
function still() {
  resume = undefined;
  el('touch').classList.remove('on');
  playing = null;
  shownFrame = -1;
  view.setActivity([]);
  view.setReadoutActivity(null);
  view.setMushroomActivity(null, null, null);
  drive(rest);
  for (const id of ['kenyon', 'avoid', 'approach', 'dan', 'feed']) el(`readout-${id}`).textContent = '—';
}
function show(frame: Frame, peak: number) {
  view.setActivity(frame.activity3d ?? []);
  view.setReadoutActivity(frame.readoutCounts ?? null);
  view.setMushroomActivity(frame.kenyonActive3d ?? null, frame.mbonCounts ?? null, frame.danCounts ?? null);
  const avoid = frame.avoidHz ?? 0,
    approach = frame.approachHz ?? 0,
    total = avoid + approach,
    share = total >= 20 ? avoid / total : 0.5;
  drive({
    feed: frame.feedHz / 90,
    groom: frame.groomHz / 200,
    escape: frame.escapeHz / 480,
    input: 0.3,
    approach: Math.max(0, (0.5 - share) / 0.5),
    avoid: Math.max(0, (share - 0.5) / 0.5),
    arousal: frame.spikes / peak,
    smell: (frame.activeKenyon ?? 0) / 300,
    dopamine: ((frame.ppl1Hz ?? 0) + (frame.pamHz ?? 0)) / 250,
  });
  el('readout-kenyon').textContent = String(frame.activeKenyon ?? 0);
  el('readout-avoid').textContent = `${avoid.toFixed(0)} Hz`;
  el('readout-approach').textContent = `${approach.toFixed(0)} Hz`;
  el('readout-dan').textContent = `${((frame.ppl1Hz ?? 0) + (frame.pamHz ?? 0)).toFixed(0)} Hz`;
  el('readout-feed').textContent = `${frame.feedHz.toFixed(0)} Hz`;
}
function tick(now: number) {
  if (playing) {
    const { recording, started, binMs, loop, peak } = playing;
    const n = recording.frames.length;
    const cycle = n * binMs + 1800;
    let t = now - started;
    if (loop && binMs) t %= cycle;
    if (resume !== undefined && t > n * binMs + 900) {
      // The touch's recording is over: hand the stage back to the slide.
      const back = resume;
      still();
      if (back) playing = { ...back, started: now };
    } else {
      const index = binMs ? Math.min(n - 1, Math.floor(t / binMs)) : n - 1;
      if (index !== shownFrame) {
        shownFrame = index;
        show(recording.frames[index], peak);
      }
    }
  }
  view.draw(now, reduce.matches);
  requestAnimationFrame(tick);
}

/** The fly's applause: its real grooming recording on the brain, with the front legs rubbing together instead of sweeping. */
function applaud(target: string) {
  home();
  if (fly) fly.groomStyle = 'rub';
  play('poke-antennae');
  // Turn to face the picture or the logo once the slide has laid out.
  requestAnimationFrame(() => {
    const r = document.querySelector('.slide.on ' + target)?.getBoundingClientRect();
    if (r) fly?.face({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  });
}

/** What a touch does, in plain words. The neuron names stay in deck.json. */
const TOUCH: Record<string, string> = {
  sugar: 'Sugar on its tongue: taste neurons fire, and the tongue comes out.',
  feet: 'Sugar on its feet (flies taste with their feet): taste neurons in its legs fire.',
  antennae: 'You touched its antennae: touch neurons fire, and it grooms.',
  eyes: 'Something big, coming fast: its looming detectors fire, and its escape neuron with them.',
  brush: 'You brushed its bristles: touch neurons all over its body fire.',
  abdomen: 'You tapped its abdomen: the sensory neurons there fire.',
};

// Touching the fly: a real recorded run of that sensory population takes the stage, whatever the slide is playing.
function touch(preset: string) {
  const recording = deck.recordings[`poke-${preset}`];
  if (!recording) return;
  if (resume === undefined) resume = playing;
  playing = playback(recording, 190, false);
  shownFrame = -1;
  const label = el('touch');
  label.textContent = TOUCH[preset] ?? recording.note;
  label.classList.add('on');
}
if (fly) {
  fly.onPoke = preset => touch(preset);
  fly.onLoom = () => touch('eyes');
}

// The deck's data, then the slides.
const deck = (await (await fetch('/deck.json')).json()) as Deck;
const anatomy = (await (await fetch('/anatomy.json')).json()) as BrainAnatomy;
view.setAnatomy(anatomy);
requestAnimationFrame(tick);
const N = deck.numbers;
const neutral = N.answerKey.neutral;

// The audience round: three changes drawn live from the pool, the room's show of hands, the fly's recorded vote, the test.
type Round = { pick: Pick; room: 'approve' | 'object' | null; revealed: number };
let rounds: Round[] = [];
const flyCall = (p: Pick) =>
  p.fly.verdict === 'no_objection' ? 'approve' : p.fly.verdict === 'changes_requested' ? 'object' : 'unsure';
const truth = (p: Pick) => (p.label === 'bug' ? 'object' : 'approve');
function drawRounds() {
  const pool = [...deck.pool];
  rounds = Array.from({ length: 2 }, () => ({
    pick: pool.splice(Math.floor(Math.random() * pool.length), 1)[0],
    room: null,
    revealed: 0,
  }));
  roundRenderers.forEach(render => render());
  renderScore();
}
const roundRenderers: (() => void)[] = [];
const scoreHosts: HTMLElement[] = [];
function tally() {
  let room = 0,
    voted = 0,
    flyScore = 0,
    played = 0;
  for (const r of rounds) {
    if (r.revealed < 2) continue;
    played++;
    if (flyCall(r.pick) === truth(r.pick)) flyScore++;
    if (!r.room) continue;
    voted++;
    if (r.room === truth(r.pick)) room++;
  }
  return { room, voted, fly: flyScore, played };
}
function renderScore() {
  const t = tally();
  for (const host of scoreHosts)
    host.textContent = t.played ? `${t.voted ? `Room ${t.room} / ${t.voted} · ` : ''}Fly ${t.fly} / ${t.played}` : '';
}

function diffBox(shown: Shown) {
  const box = make('div', 'diff');
  box.setAttribute('aria-label', `The change: ${shown.title}`);
  for (const line of shown.diff) {
    const row = make(
      'div',
      line.kind,
      `${line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}${line.text}`,
    );
    box.append(row);
  }
  return box;
}
type Call = 'approve' | 'object' | 'unsure';
const SAYS: Record<Call, string> = { approve: 'Approve', object: 'Changes requested', unsure: 'Abstains' };
/** The fly votes with its nose. */
const SNIFFS: Record<Call, string> = { approve: 'Smells good to me', object: 'Something stinks', unsure: 'Can’t tell' };
function verdictCard(who: string, call: Call | null, why = '', says = SAYS) {
  const card = make('div', `verdict ${call ?? ''}`);
  card.append(make('div', 'who', who));
  card.append(make('div', 'what', call ? says[call] : '…'));
  if (why) card.append(make('div', 'why', why));
  return card;
}
function roundSlide(i: number): Slide {
  let host: HTMLElement;
  const render = () => {
    const r = rounds[i];
    host.replaceChildren();
    html(host, `<div class="kicker">Round ${i + 1} of 2</div>`);
    if (!r) {
      html(host, `<h2>Draw the changes on the previous slide.</h2>`);
      return;
    }
    html(host, `<h2></h2>`);
    // The file, not the title: mined and drafted titles describe the edit, and a few would give the answer away.
    host.querySelector('h2')!.textContent = r.pick.filename;
    host.append(diffBox(r.pick));
    const cards = make('div', 'verdicts');
    const room = verdictCard('The room', r.room, r.room ? 'show of hands' : 'hands up: approve, or request changes?');
    const flyCard =
      r.revealed >= 1
        ? verdictCard(
            'The fly',
            flyCall(r.pick),
            `its exam answer · ${Math.round(r.pick.fly.share * 100)}% avoid${r.pick.fly.behavior === 'reached' ? ' · tongue out' : ''}`,
            SNIFFS,
          )
        : verdictCard('The fly', null, 'waiting');
    const test = make('div', `verdict ${r.revealed >= 2 ? truth(r.pick) : ''}`);
    test.append(make('div', 'who', 'The tests'));
    test.append(make('div', 'what', r.revealed >= 2 ? (r.pick.label === 'bug' ? 'A bug' : 'Harmless') : '…'));
    test.append(
      make(
        'div',
        'why',
        r.revealed >= 2 ? (r.pick.label === 'bug' ? 'a test reproduced it' : 'every test still passes') : 'not run yet',
      ),
    );
    if (r.revealed >= 2) {
      if (r.room) room.classList.add(r.room === truth(r.pick) ? 'right' : 'wrong');
      flyCard.classList.add(flyCall(r.pick) === truth(r.pick) ? 'right' : 'wrong');
      test.classList.add('right');
    }
    cards.append(room, flyCard, test);
    host.append(cards);
    const buttons = make('div', 'row');
    for (const [call, label] of [
      ['approve', 'Room approves (A)'],
      ['object', 'Room requests changes (R)'],
    ] as const) {
      const b = make('button', `button ${r.room === call ? 'on' : ''}`, label);
      b.addEventListener('click', () => {
        r.room = call;
        render();
      });
      buttons.append(b);
    }
    const score = make('span', 'score');
    scoreHosts.splice(0, scoreHosts.length, ...scoreHosts.filter(node => node.isConnected), score);
    buttons.append(score);
    host.append(buttons);
    renderScore();
  };
  roundRenderers[i] = render;
  return {
    id: `round-${i + 1}`,
    minutes: '0:50',
    className: 'wide',
    steps: 3,
    build: h => {
      host = h;
      render();
    },
    enter: step => {
      still();
      const r = rounds[i];
      if (r) {
        r.revealed = Math.max(r.revealed, step);
        render();
        if (step >= 1) {
          const call = flyCall(r.pick);
          drive({
            ...rest,
            feed: r.pick.fly.behavior === 'reached' ? 0.4 : 0,
            avoid: call === 'object' ? 0.8 : 0,
            approach: call === 'approve' ? 0.5 : 0,
          });
        }
      }
    },
    notes: [
      'Step 1: read the change aloud in one sentence. Hands up: who approves? Who requests changes? Press A or R for the majority.',
      'Step 2 (→): the fly’s vote. It is its answer from the exam; the fly gives the same answer every time, so recording it is fair. Its card speaks nose: “Smells good to me” is approve, “Something stinks” is changes requested, “Can’t tell” is abstain.',
      'Say the percentage like this: “72% of its output neurons’ firing came from the avoid side.” Over 68% is changes requested; under 45%, or tongue out, is approve; in between, “I don’t know.”',
      'Step 3 (→): the tests. Green border = right.',
    ],
  };
}

// The intro's bits. Each starts when its slide does and registers how to stop; the deck runs those on every move.
let cleanups: (() => void)[] = [];
const onLeave = (f: () => void) => cleanups.push(f);
const later = (ms: number, f: () => void) => {
  const id = setTimeout(f, ms);
  onLeave(() => clearTimeout(id));
};

// Digital rain over a dark brain: the fly before it is jacked in.
const rainCanvas = el<HTMLCanvasElement>('rain');
let rainFrame = 0;
function startRain() {
  rainCanvas.classList.remove('gone');
  if (rainFrame || reduce.matches) return;
  const ctx = rainCanvas.getContext('2d')!;
  const w = (rainCanvas.width = innerWidth),
    h = (rainCanvas.height = innerHeight);
  const size = Math.round(h / 40);
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789{}()<>=;';
  const glyph = () => glyphs[Math.floor(Math.random() * glyphs.length)];
  const drops = Array.from({ length: Math.ceil(w / size) }, () => Math.random() * -40);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${size}px ui-monospace, monospace`;
  let last = 0;
  const tick = (now: number) => {
    rainFrame = requestAnimationFrame(tick);
    if (now - last < 50) return;
    last = now;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    ctx.fillRect(0, 0, w, h);
    drops.forEach((y, i) => {
      ctx.fillStyle = '#2f5';
      ctx.fillText(glyph(), i * size, (y - 1) * size);
      ctx.fillStyle = '#dfd';
      ctx.fillText(glyph(), i * size, y * size);
      drops[i] = y * size > h && Math.random() > 0.97 ? 0 : y + 1;
    });
  };
  rainFrame = requestAnimationFrame(tick);
}
function stopRain() {
  cancelAnimationFrame(rainFrame);
  rainFrame = 0;
  rainCanvas.classList.add('gone');
}

// The jack: a cable drops from the top of the screen into the back of the fly's neck, the screen flashes, and the brain
// behind it starts firing. The flinch is the fly's real looming-detector recording. `landed` runs with the flash.
function plugIn(landed: () => void = () => {}) {
  if (!fly || reduce.matches) {
    landed();
    play('naive');
    return;
  }
  const neck = fly.screenPoint('neck');
  const top = { x: neck.x + innerWidth * 0.05, y: -20 };
  const d = `M ${top.x} ${top.y} C ${top.x} ${neck.y * 0.45}, ${neck.x + innerHeight * 0.05} ${neck.y - innerHeight * 0.2}, ${neck.x} ${neck.y}`;
  const jack = el('jack');
  for (const path of jack.querySelectorAll('path')) path.setAttribute('d', d);
  const plug = jack.querySelector('circle')!;
  plug.setAttribute('cx', String(neck.x));
  plug.setAttribute('cy', String(neck.y));
  jack.classList.remove('in');
  void jack.getBoundingClientRect();
  jack.classList.add('in');
  onLeave(() => jack.classList.remove('in'));
  later(900, () => {
    const flash = el('flash');
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
    landed();
    const eyes = deck.recordings['poke-eyes'];
    if (eyes) {
      resume = playback(deck.recordings.naive, 420, true);
      playing = playback(eyes, 150, false);
      shownFrame = -1;
    } else play('naive');
  });
}
/** Jacking it into the Matrix: the plug, and the digital rain clears with the flash. */
function jackIn() {
  startRain();
  plugIn(() => (reduce.matches ? stopRain() : rainCanvas.classList.add('gone')));
}

// Beat Saber: red and blue blocks fly at the fly on the beat, and the leg holding that color cuts each one as it lands.
// Expert+: each block is in the air for just over a beat, and the combo counter never breaks.
const SABER_LEAD = 1.25;
function sabers() {
  const stage = el('saber-stage');
  const combo = document.querySelector('.slide.on .combo b');
  const beatMs = 60000 / SABER_BPM;
  const flight = SABER_LEAD * beatMs;
  // The first blocks start already in the air, so the song is under way the moment the slide is.
  let next = Math.ceil(performance.now() / beatMs + 0.2);
  let frame = 0,
    cuts = 0;
  const spawn = (k: number, now: number) => {
    const left = k * beatMs - now;
    // A beat already gone (after a hidden tab) gets no block.
    if (!fly || left <= 0) return;
    // The right front leg (blue) cuts on even beats, the left (red) on odd ones, on the fly model's clock.
    const blue = k % 2 === 0;
    const face = fly.screenPoint('face');
    const to = { x: face.x + (blue ? 0.03 : -0.03) * innerHeight, y: face.y };
    const from = { x: innerWidth * 0.32, y: innerHeight * 0.3 };
    const block = make('div', `block ${blue ? 'blue' : 'red'}`);
    stage.append(block);
    const flying = block.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px) scale(0.1)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: `translate(${to.x}px, ${to.y}px) scale(1)`, opacity: 1 },
      ],
      { duration: flight, easing: 'cubic-bezier(0.6, 0, 1, 0.5)', fill: 'forwards' },
    );
    flying.currentTime = flight - Math.min(flight, left);
    flying.finished
      .then(() => {
        block.remove();
        if (combo) combo.textContent = String(++cuts);
        for (const [half, dx, dy, spin] of [
          ['top', -1, -1, -24],
          ['bottom', 1, 1, 18],
        ] as const) {
          const piece = make('div', `block ${blue ? 'blue' : 'red'} half ${half}`);
          stage.append(piece);
          piece
            .animate(
              [
                { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 1 },
                {
                  transform: `translate(${to.x + dx * innerHeight * 0.08}px, ${to.y + dy * innerHeight * 0.1}px) rotate(${spin}deg)`,
                  opacity: 0,
                },
              ],
              { duration: 520, easing: 'ease-out', fill: 'forwards' },
            )
            .finished.then(() => piece.remove());
        }
      })
      .catch(() => {});
  };
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    while (now >= (next - SABER_LEAD) * beatMs) spawn(next++, now);
  };
  frame = requestAnimationFrame(tick);
  onLeave(() => {
    cancelAnimationFrame(frame);
    stage.replaceChildren();
  });
}

// The live review, right on the slide: fetch the pull request, show what Jev will be sent and send it only on a second
// click (the server holds the review to that exact payload), then follow the run over the server's event stream and
// play the fly's real recording on the stage when it lands.
const postJSON = async (path: string, body: unknown) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
};
/** The pull request this slide sent, and the run that was on the server before it, so an older review never shows. */
let asked: { url: string; title: string; prevRun: string | null } | null = null;
let lastState: ReviewState | null = null;
let shownRun: string | null = null;
let livePanel: HTMLElement;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function liveMessage(text: string, kind = '') {
  livePanel.replaceChildren(make('p', `live-status ${kind}`, text.replace(/^Error: /, '')));
}
async function prepareLive(reference: string) {
  if (!reference) return;
  if (lastState && !lastState.hasJev)
    return liveMessage('Jev is not configured here (TYPESAFE_API_KEY). Use Plan B.', 'error');
  liveMessage('Fetching from GitHub…');
  try {
    const response = await fetch(`/api/pull-request?ref=${encodeURIComponent(reference)}`);
    const preview = (await response.json()) as ReviewCase & { error?: string };
    if (!response.ok) throw new Error(preview.error ?? `HTTP ${response.status}`);
    const pr = preview.pullRequest!;
    const body = { action: 'review', caseId: PULL_REQUEST_CASE_ID, mode: 'jev', pullRequest: pr.url } as const;
    const disclosure = (await postJSON('/api/review/disclosure', body)) as {
      hash: string;
      payload: { note?: string };
    };
    livePanel.replaceChildren();
    const title = make('h3', 'live-title', pr.title);
    const facts = make(
      'p',
      'caption',
      `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} by ${pr.author} · ${count(pr.changedFiles, 'file')}, +${pr.additions} −${pr.deletions}. ${disclosure.payload.note ?? ''}`,
    );
    const send = make('button', 'button primary', 'Send it to Jev and ask the fly →');
    const details = make('details', 'payload');
    details.append(
      make('summary', '', 'Exactly what TypeSafe gets'),
      make('pre', '', JSON.stringify(disclosure.payload, null, 2)),
    );
    send.addEventListener('click', () => {
      asked = { url: pr.url, title: pr.title, prevRun: lastState?.runDir ?? null };
      shownRun = null;
      liveMessage('Sending…');
      postJSON('/api/review/action', { ...body, disclosure: disclosure.hash }).catch(error =>
        liveMessage(String(error instanceof Error ? error.message : error), 'error'),
      );
    });
    livePanel.append(title, facts, make('div', 'row'));
    livePanel.querySelector('.row')!.append(send, details);
  } catch (error) {
    liveMessage(String(error instanceof Error ? error.message : error), 'error');
  }
}
/** While the simulator reads, the slide shows how long it has been at it; the server has no progress until it finishes. */
let liveClock: ReturnType<typeof setInterval> | undefined;
function onLiveState(s: ReviewState) {
  lastState = s;
  clearInterval(liveClock);
  if (!asked || s.review.pullRequest?.url !== asked.url || s.runDir === asked.prevRun) return;
  if (s.phase === 'error') return liveMessage(s.explanation, 'error');
  if (!(s.phase === 'ready' && s.brain && s.verdict)) {
    // Jev describing, then the simulator reading: the fly sniffs while it waits.
    livePanel.replaceChildren(make('h3', 'live-title', asked.title), make('p', 'live-status', s.headline));
    if (s.log[0] && s.log[0].text !== s.headline) livePanel.append(make('p', 'caption', s.log[0].text));
    if (s.phase === 'simulating' && s.log[0]) {
      const hunks = reviewUnits(s.review.pullRequest!).units.length;
      const since = Date.parse(s.log[0].at);
      const clock = make('p', 'caption');
      const tick = () => {
        const t = Math.max(0, Math.round((Date.now() - since) / 1000));
        clock.textContent = `${count(hunks, 'hunk')}, each read twice: usually a minute or two, longer on a busy laptop. ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      };
      tick();
      liveClock = setInterval(tick, 1000);
      livePanel.append(clock);
    }
    drive({ ...rest, smell: 0.9, input: 0.5, arousal: s.phase === 'simulating' ? 0.7 : 0.3 });
    return;
  }
  if (s.runDir !== shownRun) {
    shownRun = s.runDir;
    home();
    resume = undefined;
    playing = playback(s.brain as unknown as Recording, 420, true);
    shownFrame = -1;
  }
  const v = s.verdict.verdict;
  const call: Call = v === 'no_objection' ? 'approve' : v === 'changes_requested' ? 'object' : 'unsure';
  const a = s.attention;
  const unit = a ? reviewUnits(s.review.pullRequest!).units[a.looked] : null;
  const where = unit ? `${unit.filename}${unit.hunk === null ? '' : `, hunk ${unit.hunk + 1}`}` : '';
  const card = verdictCard(
    'The fly',
    call,
    !a
      ? ''
      : a.units.length === 1
        ? `it read ${where}`
        : a.stands
          ? `it looked at ${where}`
          : `nothing stood out, so it counted all ${a.tally.total}`,
    SNIFFS,
  );
  card.classList.add('stamp');
  const row = make('div', 'row');
  row.append(card);
  if (a)
    row.append(
      make(
        'p',
        'caption',
        `${count(a.units.length, a.granularity)}: ${a.tally.changes_requested} stink, ${a.tally.no_objection} smell good, ${a.tally.abstain} can’t tell${a.tally.reached ? `, tongue out on ${a.tally.reached}` : ''}.`,
      ),
    );
  livePanel.replaceChildren(make('h3', 'live-title', asked.title), row);
  if (unit)
    livePanel.append(
      diffBox({
        id: '',
        title: where,
        filename: unit.filename,
        diff: parsePatch(unit.patch)
          .slice(0, 14)
          .map(l => ({ kind: l.kind, text: l.text })),
      }),
    );
}

/** The premise's review clock: how long the pull request has waited on a human, a gag that runs at an hour a tick. */
let waited = 0;
const waitedText = (hours: number) => (hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`);

const slides: Slide[] = [
  {
    id: 'title',
    minutes: '0:00',
    className: 'center',
    bare: true,
    build: h =>
      html(
        h,
        `<div class="kicker">AI Engineer · New York</div><h1 class="cover">Are You Smarter Than A Fruit Fly?</h1><p class="byline">Nick Nisi · WorkOS</p>`,
      ),
    enter: () => still(),
    notes: [
      'Wait-on slide: nothing moves, so it can sit here while the room fills. No fly yet; it arrives with the Matrix.',
    ],
  },
  {
    id: 'me',
    minutes: '0:20',
    className: 'wide',
    bare: true,
    build: h =>
      html(
        h,
        `<div class="intro"><img class="headshot" src="/assets/nick-nisi.webp" alt="Nick Nisi" width="320" height="320" /><div><div class="kicker">Hi, I'm</div><h1>Nick Nisi</h1><p class="byline">Engineering Manager, Developer and Agent Experiences · WorkOS</p><p class="caption">nicknisi.com</p></div></div>`,
      ),
    enter: () => still(),
    notes: [
      '[NICK: who you are, in your words. On the slide: Engineering Manager, Developer and Agent Experiences at WorkOS. From your blog: seven years on JS Party.]',
    ],
  },
  {
    id: 'workos',
    minutes: '0:15',
    className: 'center',
    bare: true,
    build: h =>
      html(
        h,
        `<img class="logo" src="/assets/workos-logo-white.svg" alt="WorkOS" width="880" height="168" /><p class="caption">workos.com</p>`,
      ),
    enter: () => still(),
    notes: ['[NICK: one line about WorkOS, in your words.]'],
  },
  {
    id: 'bottleneck',
    minutes: '0:45',
    bare: true,
    steps: 3,
    build: h => {
      html(
        h,
        `<div class="kicker">Code review</div><h1>The bottleneck.</h1>
        <div class="mergebox" aria-label="A pull request: every check has passed, and merging is blocked on one human review">
          <div class="check"><b>CI / test</b><span>All tests passed</span></div>
          <div class="check"><b>CI / lint</b><span>Successful</span></div>
          <div class="check"><b>Greptile / CodeRabbit</b><span>Review completed</span></div>
          <div class="check blocked"><b>Review required</b><span>At least 1 approving review is required</span></div>
          <div class="merge-row"><button class="merge" type="button">Merge pull request</button><span class="waiting">Waiting on a human: <b>0h</b></span></div>
        </div>
        <img class="wanted step later" data-step="1" src="/assets/wanted-nick.webp" alt="A wanted poster: Nick Nisi, caught glancing back with a finger to his lips. Wanted for being a bottleneck. Merged or closed. Reward: 1 approving review." width="848" height="1264" />
        <blockquote class="step later" data-step="2">Reviewing code is the bottleneck. Humans aren't involved in writing it anymore and the functionality is what matters.</blockquote>`,
      );
      // The merge button is real enough to press, and it refuses.
      const box = h.querySelector<HTMLElement>('.mergebox')!;
      h.querySelector('.merge')!.addEventListener('click', () => {
        box.classList.remove('nope');
        void box.offsetWidth;
        box.classList.add('nope');
      });
    },
    enter: step => {
      still();
      const clock = document.querySelector('.slide.on .waiting b')!;
      if (step === 0) waited = 0;
      if (reduce.matches) {
        clock.textContent = waitedText(76);
        return;
      }
      clock.textContent = waitedText(waited);
      // Start once the checks have all gone green.
      later(waited ? 0 : 2100, () => {
        const id = setInterval(() => (clock.textContent = waitedText(++waited)), 150);
        onLeave(() => clearInterval(id));
      });
    },
    notes: [
      'Cold open: no fly and no brain yet, just the problem. The checks go green one at a time: CI, then Greptile / CodeRabbit. Then the one that isn’t a bot.',
      'Click “Merge pull request”: it shakes. Blocked. The clock is a gag: an hour every 150 ms.',
      '→ the culprit: a wanted poster of you, caught sneaking off with a finger to your lips, “for being a bottleneck. Merged or closed. Reward: 1 approving review.” AI-generated (Nano Banana Pro, from your headshot).',
      '→ your words: “Reviewing code is the bottleneck. Humans aren’t involved in writing it anymore and the functionality is what matters.”',
    ],
  },
  {
    id: 'solved',
    minutes: '1:00',
    className: 'wide',
    bare: true,
    steps: 4,
    build: h => {
      html(h, `<div class="kicker">Code review</div><h2>And it’s a bottleneck that’s going to be solved.</h2>`);
      const points = make('div', 'points');
      points.innerHTML = `<div class="point step" data-step="0"><h3>We’re not invested in the code like we once were.</h3><pre class="mini"><i>claude</i>export async function getUser(id) {
<i>claude</i>  const res = await fetch(\`/users/\${id}\`);
<i>codex</i>  if (!res.ok) throw new HttpError(res);
<i class="you">you</i>  // TODO: figure out what this does
<i>claude</i>  return res.json();</pre></div>
<div class="point step later" data-step="1"><h3>Greptile, CodeRabbit, and CI already find the bugs.</h3><pre class="mini"><b class="ok">✓</b> CI                     all tests pass
<b class="ok">✓</b> Greptile / CodeRabbit  caught the off-by-one</pre></div>
<div class="point step later" data-step="2"><h3>What it does matters more than what it looks like.</h3><pre class="mini"><s>nit: rename data to userData</s>
<s>nit: missing trailing comma</s>
<s>nit: I’d have used reduce() here</s>
<b class="ok">✓</b> does it work? yes</pre></div>
<div class="point step later" data-step="3"><h3>If review sticks around, it’s to fill your head with what’s changing and why.</h3><pre class="mini"><i>what</i>session refresh moves into middleware
<i>why</i>two tabs were refreshing one token
<i>why not</i>a lock: middleware runs once anyway</pre></div>`;
      h.append(points);
      html(h, `<p class="caption step later" data-step="3">Not advice on the code itself.</p>`);
    },
    enter: () => still(),
    notes: [
      'Your four points, one per press. The blame, the nits, and the summary are illustrations, not real code.',
      'Card 4 is the setup: the end of the talk comes back to it with what the agent should hand the human.',
      'Your line, if you want it here: “It’s a big trust issue for humans. Feels like giving up a lot of control but I think that humans are just as capable of slop as agents are.”',
    ],
  },
  {
    id: 'bug',
    minutes: '0:35',
    className: 'center',
    bare: true,
    steps: 2,
    build: h =>
      html(
        h,
        `<div class="kicker">Harvard Mark II logbook · September 9, 1947</div>
        <div class="logbook">
          <svg class="moth" viewBox="0 0 140 80" role="img" aria-label="A moth taped to the page">
            <g fill="#7d6b52" stroke="#3e3426" stroke-width="1.2">
              <path d="M70 34 C52 6 14 4 8 26 C6 40 36 46 70 40 Z" />
              <path d="M70 34 C88 6 126 4 132 26 C134 40 104 46 70 40 Z" />
              <path d="M70 40 C56 48 34 66 42 70 C52 72 64 56 70 44 Z" />
              <path d="M70 40 C84 48 106 66 98 70 C88 72 76 56 70 44 Z" />
            </g>
            <ellipse cx="70" cy="42" rx="4" ry="17" fill="#3a2f22" />
            <path d="M68 26 C62 14 56 10 50 8 M72 26 C78 14 84 10 90 8" stroke="#3a2f22" stroke-width="1.2" fill="none" />
            <rect x="0" y="30" width="44" height="12" fill="#fffbe0" opacity="0.6" transform="rotate(-18 22 36)" />
            <rect x="96" y="30" width="44" height="12" fill="#fffbe0" opacity="0.6" transform="rotate(16 118 36)" />
          </svg>
          <p><span class="time">1545</span>Relay #70 Panel F (moth) in relay.</p>
          <p>First actual case of bug being found.</p>
        </div>
        <h2 class="step later" data-step="1">2026: first actual case of a bug finding bugs.</h2>
        <p class="caption step later" data-step="1">Pedant’s corner: true bugs are Hemiptera. Moths and fruit flies don’t qualify.</p>`,
      ),
    enter: () => still(),
    notes: [
      'The Harvard Mark II logbook, September 9, 1947, 15:45: a moth taped to the page next to “First actual case of bug being found.” Grace Hopper’s team; the page is at the Smithsonian.',
      'Say: “The bots find the bugs. So I did the obvious thing and hired a bug.”',
      '→ the punchline. The pedant’s corner is true: true bugs are Hemiptera; moths are Lepidoptera, fruit flies Diptera.',
    ],
  },
  {
    id: 'matrix',
    minutes: '0:30',
    className: '',
    steps: 2,
    build: h => html(h, `<p class="wake" data-step="0">Wake up, fly…</p>`),
    enter: step => {
      home();
      document.querySelector('.slide.on .wake')?.classList.toggle('gone', step !== 0);
      onLeave(() => {
        if (slides[index].id !== 'matrix') stopRain();
      });
      // Unplugged, the readout strip has nothing to read.
      document.body.classList.toggle('unplugged', step === 0);
      onLeave(() => document.body.classList.remove('unplugged'));
      if (step === 0) {
        still();
        startRain();
      } else jackIn();
    },
    notes: [
      'Dark, digital rain, and the fly on screen for the first time. Your words: “We’re effectively connecting the fly to the Matrix.”',
      '→ jacks it in: the cable drops into its neck, the screen flashes, and the brain behind you starts firing. The flinch is a real recording: its looming detectors and escape neuron.',
      'Behind you from here on: a real simulated fruit-fly brain, every point a measured neuron position.',
    ],
  },
  {
    id: 'games',
    minutes: '0:30',
    className: 'wide',
    steps: 2,
    build: h =>
      html(
        h,
        `<div class="kicker">This fall, people plugged a fruit fly’s brain into games</div>
        <h2>Doom. <span class="step later" data-step="1">Beat Saber.</span></h2>
        <div class="combo step later" data-step="1" aria-hidden="true"><span>Expert+</span><b>0</b><span>combo · 100% · <em>SS</em></span></div>
        <div class="doom-wrap"><canvas class="doom" aria-label="A Doom-style corridor the fly is playing"></canvas></div>
        <p class="caption">Doom: nftechie/doomfly. Beat Saber: lyra bubbles. My fly runs on an engine that started as a Minecraft mod. These animations are mine, not their footage.</p>`,
      ),
    enter: step => {
      home();
      play('naive');
      const host = el('fly');
      host.classList.add('star');
      if (fly) fly.tall = true;
      const screen = document.querySelector<HTMLElement>('.slide.on .doom-wrap');
      screen?.classList.toggle('gone', step !== 0);
      onLeave(() => {
        host.classList.remove('star');
        if (fly) {
          fly.act = null;
          fly.tall = false;
        }
      });
      onLeave(() => (override = null));
      if (step === 0) {
        // The fly plays it: it faces the screen and walks when the player walks, and every turn the player makes swings
        // it the same way (a turn that eases back toward the screen over about a second).
        const r = screen?.getBoundingClientRect();
        if (r) fly?.face({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        let swing = 0;
        const stop = doom(document.querySelector<HTMLCanvasElement>('.slide.on .doom')!, {
          move: (turned, walking, dt) => {
            if (!fly) return;
            swing = (swing + turned) * Math.exp(-dt / 0.9);
            fly.steer = Math.max(-1.3, Math.min(1.3, swing));
            fly.walk = walking ? 1 : 0.6;
          },
          fire: flinch,
        });
        onLeave(stop);
        onLeave(() => {
          if (!fly) return;
          fly.steer = 0;
          fly.walk = 0;
        });
      } else {
        if (fly) fly.act = 'saber';
        fly?.face({ x: innerWidth * 0.32, y: innerHeight * 0.3 });
        sabers();
      }
    },
    notes: [
      'The fly plays along: it walks when the player walks, turns when the player turns, and jumps at every shot. Scripted to the animation, not neurons. Real fly-VR rigs do put a fly on a floating ball and let it walk through a virtual world.',
      'Doom: nftechie/doomfly, the MaleCNS wiring in a live Doom arena. Its own README: “live experimental training, not demonstrated learned survival.”',
      'Beat Saber: lyra bubbles, September 2026. The creator said its motor system was trained to replay a recorded sequence; real-time playing was still in progress.',
      'Minecraft: Fly Brain Minecraft (blendi-remade/fly-brain-minecraft), the engine and connectome file this fly runs on.',
      '[NICK: you said “taught to play.” The projects themselves say plugged in, not yet learned. “Plugged into” is the safe word on stage.]',
      '→ the sabers: blocks land on the beat (100 BPM, the tempo in the Beat Saber clip) and the leg holding that color cuts them. Expert+: each block is in the air for just over a beat, and the combo never breaks.',
      'Optional line: “In my version, it’s mastered Beat Saber. Nobody has mastered JavaScript.”',
    ],
  },
  {
    id: 'punishment',
    minutes: '0:25',
    steps: 2,
    build: h =>
      html(
        h,
        `<div class="kicker">Then I gave it</div><h1>The ultimate form of punishment: reviewing JavaScript.</h1>
        <pre class="wat step later" data-step="1">[10, 1, 2].sort()     // [1, 10, 2]
"10" + 1              // "101"
"10" - 1              // 9
0.1 + 0.2 === 0.3     // false
typeof null           // "object"</pre>
        <p class="caption step later" data-step="1">Behind me: a real recording of its punishment neurons firing.</p>
        <div class="aaah" aria-hidden="true">AAAAAAAH!</div>`,
      ),
    enter: step => {
      home();
      if (step === 0) {
        still();
        // The news lands, and the fly screams: rears up, throws its front legs over its head, and shakes.
        const aaah = document.querySelector('.slide.on .aaah');
        later(450, () => {
          if (fly) fly.act = 'scream';
          aaah?.classList.add('on');
        });
        onLeave(() => {
          if (fly) fly.act = null;
          aaah?.classList.remove('on');
        });
        return;
      }
      const code = document.querySelector('.slide.on .wat')?.getBoundingClientRect();
      if (code) fly?.face({ x: code.left + code.width / 2, y: code.top + code.height / 2 });
      // It looks, then turns its back on it.
      later(1400, () => {
        play('bitter');
        fly?.face({ x: innerWidth * 3, y: innerHeight * 0.7 });
      });
    },
    notes: [
      'Your words: “the ultimate form of punishment, which is reviewing JavaScript.” The fly hears it and screams: reared up, front legs over its head, shaking. Scripted, not a recording.',
      '→ the code. The fly looks, then turns its back. The brain is the real bitter-lesson recording: its punishment dopamine neurons firing. That’s how it learns later, so this is a setup.',
    ],
  },
  {
    id: 'kungfu',
    minutes: '0:10',
    build: h =>
      html(h, `<h1 class="upload">I know code review.</h1><p class="caption upload">It doesn’t. Not yet.</p>`),
    enter: () => {
      home();
      still();
      // The upload: the plug comes down into its neck, and the line lands with the flash.
      const lines = document.querySelectorAll('.slide.on .upload');
      lines.forEach(line => line.classList.add('step', 'later'));
      plugIn(() => lines.forEach(line => line.classList.remove('later')));
    },
    notes: [
      'The upload: the plug comes down into its neck again, the screen flashes, and the fly delivers its Neo line, after its JavaScript “training”: “I know kung fu.” It doesn’t know code review yet; teaching it is the rest of the talk.',
    ],
  },
  {
    id: 'connectome',
    minutes: '0:45',
    build: h => {
      html(
        h,
        `<div class="kicker">First: what’s a connectome?</div><h2>A complete wiring diagram of a brain.</h2><p>Every neuron, and every connection between them. Scientists imaged a male fruit fly’s brain and nerve cord under an electron microscope, 8 nanometers at a time, and traced it neuron by neuron.</p>`,
      );
      const stats = make('div', 'duel three');
      stats.innerHTML = `<div><div class="num">${N.neurons.toLocaleString()}</div><p>neurons</p></div><div><div class="num">${(N.connections / 1e6).toFixed(1)}M</div><p>connections</p></div><div><div class="num">125M</div><p>synapses counted</p></div>`;
      h.append(stats);
      html(
        h,
        `<p class="caption">In your terms: a directed graph. Every dot behind me is one node, at its real position. Data: male-cns v1.0, HHMI Janelia, Cambridge, Google Research, CC BY 4.0.</p>`,
      );
    },
    enter: () => {
      home();
      play('naive');
    },
    notes: [
      'Say: “A connectome is a wiring diagram. Someone took a real fly, imaged its whole nervous system under an electron microscope, and traced every neuron and every connection. Behind me is that map: every dot is a neuron where it really sits.”',
      'Say: “For us it’s a graph: about 176 thousand nodes, 6.3 million edges. The strength of each edge is how many synapses the scientists counted. Nobody trained the map. Evolution built it.”',
      'Detail if asked: connections with 5 or more synapses are kept (24% of connections, 72% of synapses). Whether a connection excites or inhibits comes from the sending neuron’s neurotransmitter.',
    ],
  },
  {
    id: 'project',
    minutes: '0:45',
    steps: 3,
    build: h =>
      html(
        h,
        `<div class="kicker">What I built</div><h2>I made the map run. Then I taught it code review.</h2>
        <ol class="build-list">
          <li class="step" data-step="0"><strong>Run it.</strong> Each neuron is a few lines of math: add up incoming spikes, leak a little, fire when it crosses a threshold. All ${N.neurons.toLocaleString()} of them, for 450 ms of fly time: about two seconds on this laptop.</li>
          <li class="step later" data-step="1"><strong>Don’t touch it.</strong> All ${(N.connections / 1e6).toFixed(1)} million connections come from the map, and I never train them.</li>
          <li class="step later" data-step="2"><strong>Let one part learn.</strong> ${N.plasticSynapses.toLocaleString()} connections in its memory center can change, and only test results change them.</li>
        </ol>
        <p class="caption step later" data-step="2">In your terms: a frozen network, wired by evolution, with one small layer that test results train.</p>`,
      ),
    enter: () => {
      home();
      play('naive');
    },
    notes: [
      'Say: “I didn’t design a neural network. I downloaded one, made it run, and asked it about code.”',
      'If asked how it runs: a leaky integrate-and-fire model, the method of Shiu et al., Nature 2024. Java, on this laptop.',
      '→ → one line per press.',
    ],
  },
  {
    id: 'how',
    minutes: '0:45',
    className: 'wide',
    steps: 5,
    build: h => {
      html(
        h,
        `<div class="kicker">How it works</div><h2>A fruit fly can’t read code. Here’s how it reviews it anyway.</h2>`,
      );
      const parts: [string, string, string][] = [
        [
          '1 · The nose',
          'An AI model answers 30 yes-or-no questions about what changed. The answers become a smell.',
          'Feature extraction',
        ],
        [
          '2 · The memory',
          `The smell lights up about 5% of its ${N.kenyonCells.toLocaleString()} memory cells. Similar descriptions, similar cells.`,
          'Hashing',
        ],
        [
          '3 · The teacher',
          'A test result is a taste. Bug reproduced: bitter. Tests pass: sugar. Dopamine rewires what just lit up.',
          'Training: the write',
        ],
        ['4 · The vote', 'If the smell alone makes its tongue come out, it approves.', 'Inference: the read'],
      ];
      const pipe = make('div', 'pipeline four');
      parts.forEach(([title, body, term], i) => {
        const s = make('div', 'station step later');
        s.dataset.step = String(i);
        s.innerHTML = `<span class="packet"></span><h3></h3><p></p><p class="term"></p>${i < 3 ? '<span class="arrow"></span>' : ''}`;
        s.querySelector('h3')!.textContent = title;
        s.querySelector('p')!.textContent = body;
        s.querySelector('.term')!.textContent = term;
        pipe.append(s);
      });
      h.append(pipe);
      html(
        h,
        `<p class="step later summary" data-step="4">A hash table where similar keys collide on purpose, and the tests write the values.</p>`,
      );
    },
    enter: step => {
      home();
      play(['objects', 'objects', 'sugar', 'reaches', 'reaches'][step]);
      document.querySelectorAll('.slide.on .station').forEach((s, i) => s.classList.toggle('active', step === i));
    },
    notes: [
      'One press per part; the fly acts each one out. The teacher and the vote get their own slides next; the nose and the memory live only here now.',
      'Nose line, if you want it: “We’ve called them code smells for decades. I took it literally.”',
      'If anyone asks for the real names: the smell channels are glomeruli, the memory cells are Kenyon cells in the mushroom body, the two output groups are MBONs, the tongue is the proboscis.',
      'For this room, optional: the fly’s smell circuit has been described as locality-sensitive hashing (Dasgupta, Stevens & Navlakha, Science, 2017).',
    ],
  },
  {
    id: 'teacher',
    minutes: '1:00',
    steps: 2,
    build: h =>
      html(
        h,
        `<div class="kicker">3 · The teacher</div><h2>Step 3: a test result is a taste.</h2>
        <p data-step="0" class="step">A test reproduces the bug: <strong>bitter</strong>. Punishment dopamine fires (${Math.round(deck.recordings.bitter.ppl1Hz)} Hz) and weakens the lit cells’ wires to <strong class="green">approach</strong>.</p>
        <p data-step="1" class="step later">Every test still passes: <strong>sugar</strong>. Reward dopamine fires (${Math.round(deck.recordings.sugar.pamHz)} Hz), weakens their wires to <strong class="red">avoid</strong>, and the tongue comes out.</p>
        <blockquote class="step later" data-step="1">I tried to train the fly on the codebase by using mutation testing to identify good and bad parts of the code and then train the fly to have memories based on that.</blockquote>
        <p class="caption">What that means now: the bugs are mutants a real test caught. The harmless ones are refactors that pass every test. An opinion teaches nothing.</p>`,
      ),
    enter: step => {
      view.focusMushroomBody(true);
      play(step === 0 ? 'bitter' : 'sugar');
    },
    notes: [
      'Pink flashes are the dopamine neurons. Bitter first; → sugar, watch the fly reach during the lesson.',
      'Only a test can teach it: nothing is learned from an opinion. If asked: PPL1 neurons carry bitter, PAM neurons carry sugar.',
      'The quote is yours (interview).',
    ],
  },
  {
    id: 'vote',
    minutes: '0:45',
    steps: 2,
    build: h =>
      html(
        h,
        `<div class="kicker">4 · The vote</div><h2>Step 4: tongue out means SGTM.</h2><p class="aside">Smells good to me.</p>
        <p class="step" data-step="0">A harmless change. The smell alone brings its tongue out: <strong>the fly reached for it</strong>. Approve. (${deck.recordings.reaches.review!.title})</p>
        <p class="step later" data-step="1">A real bug. <strong class="red">Avoid</strong> outweighs <strong class="green">approach</strong> more than two to one: <strong>changes requested</strong>. Too close to call, it abstains. (${deck.recordings.objects.review!.title})</p>
        <p class="caption step later" data-step="1">It can’t leave a single nit. All it can do is stick its tongue out.</p>`,
      ),
    enter: step => {
      home();
      view.focusReadout(step === 0 ? 0 : null);
      play(step === 0 ? 'reaches' : 'objects');
    },
    notes: [
      'Watch the fly in the corner, not me. Green in the strip = the tongue’s motor neuron (MN9, if asked).',
      'The rule: avoid more than 68% of the two groups’ output is changes requested; under 45% with no reach leans approve; in between, it abstains.',
    ],
  },
  {
    id: 'exam',
    minutes: '0:45',
    className: 'wide',
    build: h => {
      html(
        h,
        `<div class="kicker">How it studied, and how I tested it</div><h2>${N.lessons} flashcards. Then an exam it had never seen.</h2>`,
      );
      const cols = make('div', 'duel');
      cols.innerHTML = `<div><div class="kicker">Study</div><div class="num">${N.lessons}<small> lessons</small></div><ul>
          <li><strong>Bugs:</strong> mutation testing on three real TypeScript repos. Kept only if a real test failed.</li>
          <li><strong>Harmless:</strong> rewrites like flipping an if/else or renaming a variable. Kept only if every test still passed.</li>
          <li>Plus small examples Claude wrote, checked by running them.</li>
          <li>Half bugs, half harmless. It went through the pile ${N.passes} times.</li></ul></div>
        <div><div class="kicker">Exam</div><div class="num">${N.heldOut}<small> changes</small></div><ul>
          <li>Never studied. Whole functions were held back, so no exam question has a sibling in the flashcards.</li>
          <li><strong>${N.caught[1]}</strong> bugs, <strong>${N.approved[1]}</strong> harmless. Every answer checked by running a test.</li></ul></div>`;
      h.append(cols);
      html(
        h,
        `<p class="caption">In your terms: a train/test split. ${N.passes} epochs, learning rate ${N.rate}, picked on a practice slice of the training set, never on the exam.</p>`,
      );
    },
    enter: () => still(),
    notes: [
      `Say: “It studied ${N.lessons} flashcards. Every flashcard is a real code change, and a test decided the answer: a test failed, so bitter, or every test passed, so sugar. It went through the stack ${N.passes} times. Then I gave it ${N.heldOut} changes it had never seen. That’s the exam, and every number from here on is from it.”`,
      'The three repos: authkit-nextjs, authkit-js, ufo. “Mutation testing” = a tool (StrykerJS) makes small bugs on purpose; a mutant that makes a real test fail is a proven bug.',
      'If asked “why so few harmless ones on the exam?”: harmless rewrites are harder to make than bugs. That’s why the score on the next slides averages the two halves.',
      'Honest footnotes if asked: (1) every harmless example is a refactor. Measured: on 24 tickets that change what a function should do, it approved 0 of 24 correct changes and caught 22 of 24 wrong ones, the same verdict for both 22 times (data/intent.json). It learned “did behavior change,” not “is it right.” (2) Switching off the two answer-key questions was decided after seeing them sort this exam; the learning rate and epochs were picked without it. (3) Exam functions are held out, but the repos are the same three.',
    ],
  },
  {
    id: 'proof',
    minutes: '0:50',
    className: 'wide',
    steps: 2,
    build: h => {
      html(
        h,
        `<div class="kicker">The ablation</div><h2>Break where the teacher’s signal lands, and it stops catching bugs.</h2><p>Same nose, same lessons. Shuffle only which output neurons the dopamine reaches.</p>`,
      );
      const duel = make('div', 'duel');
      duel.innerHTML = `<div class="good" data-side="real"><div class="kicker">Real wiring</div><div class="num">${N.caught[0]}<small> / ${N.caught[1]}</small></div><p>bugs caught</p></div>
        <div class="bad dim" data-side="scrambled"><div class="kicker">Scrambled</div><div class="num">${N.shuffled.caught[0]}<small> / ${N.shuffled.caught[1]}</small></div><p>bugs caught · ${N.shuffled.bugsApproved} approved</p></div>`;
      h.append(duel);
      html(
        h,
        `<p class="caption">Out of the ${N.caught[1]} bugs on the exam. The nose carries the information (a spreadsheet reading it does better); the fly has to learn what it means. Untrained, it says “I don’t know” to all ${N.heldOut}. Press S to switch.</p>`,
      );
    },
    enter: step => {
      home();
      play(step === 0 ? 'objects' : 'scrambled');
      document.querySelector('[data-side="real"]')?.classList.toggle('dim', step !== 0);
      document.querySelector('[data-side="scrambled"]')?.classList.toggle('dim', step === 0);
    },
    notes: [
      `Say: “Same nose, same lessons. Real wiring: it catches ${N.caught[0]} of the ${N.caught[1]} exam bugs. Scramble where its teacher’s signal lands and it catches ${N.shuffled.caught[0]}, and approves ${N.shuffled.bugsApproved}. The fly has to learn, and it learns through that wiring.”`,
      'Don’t claim more: this shows the learning depends on the dopamine wiring lining up with the output neurons. It does not show fly wiring beats any other learner; the spreadsheet on a later slide beats it.',
      '→ scrambles. Same bug, same smell: with scrambled wiring the fly reaches for it. Every neuron keeps the same number of connections; only who-talks-to-whom changed.',
    ],
  },
  {
    id: 'game',
    minutes: '0:30',
    className: 'center',
    build: h => {
      html(
        h,
        `<div class="kicker">Audience round: you vs. a bug</div><h1>Are you smarter than a fruit fly?</h1><p>Two real changes. Hands up: approve or request changes. Then the fly. Then the tests.</p>`,
      );
      const draw = make('button', 'button primary', 'Draw two changes');
      draw.addEventListener('click', () => {
        drawRounds();
        draw.textContent = 'Drawn. Draw again';
      });
      h.append(draw);
      html(h, `<p class="caption">${deck.poolRule}</p>`);
    },
    enter: () => {
      home();
      play('naive');
    },
    notes: [
      'Click Draw (random, live). Say how the pool was made; the caption has it. The fly’s answers are fixed in advance because it is deterministic; the live draw is what keeps the round honest.',
    ],
  },
  roundSlide(0),
  roundSlide(1),
  {
    id: 'numbers',
    minutes: '0:50',
    className: 'wide',
    build: h => {
      html(
        h,
        `<div class="kicker">The whole exam: telling bugs from tidy-ups</div><h2>${N.heldOut} changes it had never seen.</h2>`,
      );
      const bars = make('div', 'bars');
      const rows: [string, number, string][] = [
        ['Coin flip', 0.5, ''],
        ['The fruit fly', N.balanced, 'is-fly'],
        ['Best single clue', neutral.single, ''],
        ['A spreadsheet', neutral.logistic, ''],
      ];
      for (const [label, value, kind] of rows) {
        const row = make('div', `bar ${kind}`);
        row.innerHTML = `<span></span><div class="track"><div class="fill"></div></div><span class="value">${pct(value)}</span>`;
        row.querySelector('span')!.textContent = label;
        (row.querySelector('.fill') as HTMLElement).dataset.width = String(value * 100);
        bars.append(row);
      }
      const room = make('div', 'bar room');
      room.innerHTML = `<span>This room</span><div class="track"><div class="fill"></div></div><span class="value">—</span>`;
      bars.append(room);
      h.append(bars);
      html(
        h,
        `<p>Of the <strong>${N.caught[1]}</strong> bugs, it caught <strong>${N.caught[0]}</strong>. Of the <strong>${N.approved[1]}</strong> harmless changes, it approved <strong>${N.approved[0]}</strong>. ${N.abstained} times it said “I don’t know.”</p><p class="caption">Every harmless change on this exam is a tidy-up that leaves behavior alone. Why not just percent right? Three in four exam changes are bugs, so a fly that rejected everything would be ${Math.round((N.caught[1] / N.heldOut) * 100)}% right. These scores average the two halves instead, so rejecting everything scores 50%: a coin flip.</p>`,
      );
    },
    enter: () => {
      still();
      const t = tally();
      const room = document.querySelector<HTMLElement>('.bar.room');
      if (room) {
        room.hidden = !t.voted;
        room.querySelector('.value')!.textContent = t.voted ? `${t.room}/${t.voted}` : '—';
        (room.querySelector('.fill') as HTMLElement).dataset.width = String(t.voted ? (t.room / t.voted) * 100 : 0);
      }
      requestAnimationFrame(() => {
        for (const fill of document.querySelectorAll<HTMLElement>('.slide.on .fill'))
          fill.style.width = `${fill.dataset.width}%`;
      });
    },
    notes: [
      `Say: “On the exam, it caught ${N.caught[0]} of ${N.caught[1]} bugs and approved ${N.approved[0]} of ${N.approved[1]} harmless changes. Average those and you get ${pct(N.balanced)}. A coin flip gets 50.”`,
      `Say: “And a spreadsheet beats it. A logistic regression reading the exact same 53 numbers gets ${pct(neutral.logistic)}. The fly isn’t the best classifier here. It’s a fly.”`,
      '“Best single clue” is the one smell channel that does best alone. Both comparisons were fit on the same flashcards.',
      'The room bar is two questions, not ' + N.heldOut + '. Say so.',
    ],
  },
  {
    id: 'live',
    minutes: '1:00',
    build: h => {
      html(h, `<div class="kicker">Live</div><h2>Now it’s been taught. Give it a real pull request.</h2>`);
      const row = make('div', 'row');
      const input = make('input', 'pr-input');
      input.placeholder = 'owner/repo#123';
      input.setAttribute('aria-label', 'Pull request to review live');
      const go = make('button', 'button primary', 'Fetch it');
      go.addEventListener('click', () => void prepareLive(input.value.trim()));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') go.click();
      });
      const recorded = make('button', 'button', 'Plan B: a recorded run');
      recorded.addEventListener('click', () => {
        home();
        play('objects');
      });
      row.append(input, go, recorded);
      livePanel = make('div', 'live-panel');
      livePanel.setAttribute('aria-live', 'polite');
      h.append(row, livePanel);
      html(
        h,
        `<p class="caption">Each hunk goes to Jev only after the second click. A pull request is never executed. The fly votes; nothing checks the vote.</p>`,
      );
    },
    enter: () => {
      home();
      still();
      // Follow the server's review; coming back to the slide replays the last result.
      shownRun = null;
      const events = new EventSource('/review-events');
      events.onmessage = e => onLiveState(JSON.parse(e.data) as ReviewState);
      onLeave(() => {
        events.close();
        clearInterval(liveClock);
      });
    },
    notes: [
      'Moved here from the opening: the fly has been taught by now. On a real feature PR it will most likely object or abstain on the code hunks, which sets up the next slide. If it approves, it was probably looking at docs, tests, or config; say so.',
      'Pick a PR with a handful of hunks. A 25-hunk PR took 2:50 on this laptop while it was busy; the slide shows a clock while the fly reads, but that is a long silence on stage.',
      'Ask someone in the room for an open-source PR, or have one ready. Small PRs are faster: each hunk is one Jev call, and a 32-hunk PR takes the simulation one to two minutes to read.',
      'Type it, Enter: it fetches the PR and shows its title and what Jev will be sent. Click “Send it to Jev and ask the fly”. The status follows Jev, then the simulator; when it lands, the brain behind you plays the real recording, the fly reacts, and its vote is stamped with the hunk it looked at.',
      'Wifi dies → “Plan B: a recorded run” plays a real recording of the fly catching a bug.',
      'If asked: the wiring map is a connectome, male-cns v1.0 from HHMI Janelia, Cambridge, and Google.',
      'Line to use, yours: “I like the idea of having your code reviewed by a fruit fly and the analogy that I’m so smooth-brained that it’s better at code review than me at this point.”',
    ],
  },
  {
    id: 'harder',
    minutes: '1:00',
    className: 'wide',
    steps: 2,
    build: h => {
      const I = N.intent;
      const [right] = deck.intentExample;
      html(
        h,
        `<div class="kicker">Then I gave it a harder test</div><h2>Changes that are supposed to change what the code does.</h2><p class="ticket">Ticket: <strong>${right.title}</strong></p>`,
      );
      const pair = make('div', 'pair');
      const call = (verdict: string): Call =>
        verdict === 'no_objection' ? 'approve' : verdict === 'changes_requested' ? 'object' : 'unsure';
      for (const ex of deck.intentExample) {
        const side = make('div', `pair-side ${ex.kind}`);
        side.append(make('div', 'kicker', ex.kind === 'right' ? 'Does what the ticket asks' : 'A plausible mistake'));
        side.append(diffBox(ex));
        side.append(verdictCard('The fly', call(ex.fly.verdict), `${Math.round(ex.fly.share * 100)}% avoid`));
        pair.append(side);
      }
      h.append(pair);
      html(
        h,
        `<div class="step later" data-step="1"><p>${I.tickets} tickets like this. Correct changes it approved: <strong>${I.rightApproved[0]} of ${I.rightApproved[1]}</strong>. The same verdict for the right and the wrong change: <strong>${I.sameVerdict} of ${I.tickets}</strong>.</p><p class="caption">Not a strange test: tidy-ups of the same code, it approved ${I.refactorsApproved[0]} of ${I.refactorsApproved[1]}. On real pull requests it objected to ${I.prCode.objected} of ${I.prCode.total} code changes and approved ${I.prCode.approved}. A spreadsheet reading the same smells does no better: ${pct(I.spreadsheetBalanced)}.</p></div>`,
      );
    },
    enter: () => {
      home();
      play('intent-right');
    },
    notes: [
      'Say: “On the exam, every harmless change was a tidy-up that changed nothing. So I wrote tickets that change what the code should do. Free shipping from $50, not over $100. One change does it right, one gets the boundary wrong. The fly rejects both.”',
      `→ the numbers. Say: “${N.intent.tickets} tickets. It approved ${N.intent.rightApproved[0]} of the correct changes, and gave the right and the wrong change the same answer ${N.intent.sameVerdict} times.”`,
      'What it means, plainly: it learned that a change in behavior means a bug, because on the exam that was always true. Whether a change is what you wanted, nothing it smells can say.',
      'Behind you: the real recording of the trained fly smelling the correct free-shipping change. It backs away.',
      'Don’t present “caught 22 of 24 wrong changes” as a strength: it objects to everything that changes behavior.',
      'Sources: data/intent.json (24 hand-written tickets, labels proven by execution, scored once), data/intent-refactor.json (the tidy-up check), data/pr-smells.json (every source-code hunk of 8 merged authkit-nextjs PRs; each hunk’s own vote, where a reach approves).',
    ],
  },
  {
    id: 'question',
    minutes: '1:00',
    className: 'center',
    build: h =>
      html(
        h,
        `<blockquote class="big">If a fruit fly can do code review moderately well, then why are humans still doing it?</blockquote>
        <p class="step later" data-step="1">What it learned is <strong>what changed</strong>: a default changed, a conditional removed, logic removed. Nothing in it knows <strong>why</strong>.</p>`,
      ),
    steps: 2,
    enter: step => {
      still();
      if (step === 0) flight();
    },
    notes: [
      'The turn. Your words, verbatim (interview). The fly takes its one flight here.',
      '[NICK: your answer to your own question, in your words. What it can stand on: it tells bugs from tidy-ups; it can’t tell whether a change is what you wanted. It pays off card 4 of “solved”: “If review sticks around, it’s to fill your head with what’s changing and why.”]',
      '→ the why. Your line: “Agents can verify that it’s logically correct but we need to make sure that it makes sense for the use case or the application.”',
    ],
  },
  {
    id: 'proposal',
    minutes: '2:00',
    className: 'wide',
    steps: 7,
    build: h => {
      html(
        h,
        `<div class="kicker">What I propose instead</div><h2>Take humans out of every review. Escalate the ones that need them.</h2>`,
      );
      const stations: [string, string, string][] = [
        ['Team review skill', 'Code owners maintain how their team reviews.', ''],
        ['Classifier', 'Jev or another model: too complex? risky?', ''],
        ['Automated review', 'Tests, evidence, the team’s checks.', 'fly-station'],
        ['Merge, or escalate', 'Passes cleanly → merge. Fails or too complex → a human.', ''],
        ['A human, summarized', 'Just the business logic, the why, and why not the alternatives.', 'human'],
      ];
      const pipe = make('div', 'pipeline');
      stations.forEach(([title, body, kind], i) => {
        const s = make('div', `station ${kind} step later`);
        s.dataset.step = String(Math.min(i, 4) + 1);
        s.innerHTML = `<span class="packet"></span><h3></h3><p></p>${i < 4 ? '<span class="arrow"></span>' : ''}`;
        s.querySelector('h3')!.textContent = title;
        s.querySelector('p')!.textContent = body;
        pipe.append(s);
      });
      h.append(pipe);
      html(
        h,
        `<blockquote class="step later skill-quote" data-step="1">…having them maintain a skill, for lack of a better term, that is how that team would do code reviews.</blockquote><p class="caption step later" data-step="3">Every pipeline needs a fly on the wall.</p>`,
      );
      // The last press: what the agent hands the human at the end of the line.
      const receipt = make('div', 'step later handoff');
      receipt.dataset.step = '6';
      const receipts = make('div', 'receipts');
      for (const item of [
        'videos',
        'screenshots',
        'test results',
        'command output',
        'smoke tests',
        'easy ways for me to replicate that as well',
      ])
        receipts.append(make('span', '', item));
      receipt.append(receipts);
      html(
        receipt,
        `<blockquote>…what the code is doing and why, and specifically why not other methods.</blockquote>`,
      );
      h.append(receipt);
    },
    enter: step => {
      still();
      document.querySelectorAll('.slide.on .station').forEach((s, i) => s.classList.toggle('active', step - 1 === i));
      document.querySelector('.slide.on .skill-quote')?.classList.toggle('gone', step >= 6);
      el('fly').classList.add('station-seat');
    },
    notes: [
      'Your proposal, verbatim: “…having individual teams where we might have code owners before that are assigned to it, having them maintain a skill, for lack of a better term, that is how that team would do code reviews. Along with some like classification, potentially with Jev or other models that can decide whether something is too complex, or if it fails the team’s automated review system, then it gets escalated to a human to review in a summarized way, where they’re focusing on just the business logic or just the bits that actually make sense.”',
      '→ walks a PR through, one station per press. The fly sits on “Automated review”: that station is what it can do (bug or tidy-up?); the human box is what it can’t (is this what we wanted?).',
      '→ the last press: what the agent hands the human. The list and the quote are yours (interview, and the Sept 18 pitch).',
    ],
  },
  {
    id: 'close',
    minutes: '0:30',
    className: 'center',
    build: h =>
      html(
        h,
        `<img class="qr" src="/assets/fruitfly-qr.svg" alt="QR code for fruitfly.review" width="290" height="290" /><div class="url">fruitfly.review</div><p>Run it on your own pull request.</p><p class="aside">Smell you later.</p>`,
      ),
    enter: () => {
      el('fly').classList.remove('station-seat');
      applaud('.qr');
    },
    notes: [
      'The QR code goes to https://fruitfly.review. The fly turns to it and claps: the brain is its real grooming recording, front legs rubbing together, as flies do when they groom.',
      '[NICK: closing line, in your words.] “Smell you later” is on the slide; cut it if it groans too hard.',
    ],
  },
];

// The fly's one flight: wings up, off its seat, around the room, and back.
let flown = false;
function flight() {
  if (flown || reduce.matches || !fly) return;
  flown = true;
  const host = el('fly');
  override = { escape: 0.9, feed: 0, approach: 0, avoid: 0 };
  drive(rest);
  host.classList.add('flying');
  host.addEventListener(
    'animationend',
    () => {
      host.classList.remove('flying');
      override = null;
      drive(rest);
    },
    { once: true },
  );
}

// Build every slide once; navigation only toggles them.
const host = el('deck');
const built = slides.map(s => {
  const node = make('section', `slide ${s.className ?? ''}`);
  node.setAttribute('aria-roledescription', 'slide');
  s.build(node);
  host.append(node);
  return node;
});
let index = 0,
  step = 0;
const started = Date.now();
function go(i: number, s = 0) {
  index = Math.max(0, Math.min(slides.length - 1, i));
  step = Math.max(0, Math.min((slides[index].steps ?? 1) - 1, s));
  built.forEach((node, j) => node.classList.toggle('on', j === index));
  const layout = slides[index].className ?? '';
  document.body.dataset.layout = layout.includes('center') ? 'center' : layout.includes('wide') ? 'wide' : 'left';
  for (const node of built[index].querySelectorAll<HTMLElement>('[data-step]'))
    node.classList.toggle('later', Number(node.dataset.step) > step);
  if (slides[index].id !== 'proposal') el('fly').classList.remove('station-seat');
  document.body.classList.toggle('bare', !!slides[index].bare);
  if (fly && slides[index].id !== 'close') {
    fly.groomStyle = 'sweep';
    fly.face(null);
  }
  if (slides[index].id !== 'question') flown = false;
  const done = cleanups;
  cleanups = [];
  done.forEach(f => f());
  if (slides[index].id !== 'memory' && slides[index].id !== 'teacher') view.focusMushroomBody(false);
  slides[index].enter?.(step);
  history.replaceState(null, '', `#${index + 1}${step ? `.${step}` : ''}`);
  el('progress').style.width = `${((index + 1) / slides.length) * 100}%`;
  renderNotes();
}
function next() {
  if (step < (slides[index].steps ?? 1) - 1) go(index, step + 1);
  else go(index + 1, 0);
}
function prev() {
  if (step > 0) go(index, step - 1);
  else go(index - 1, 0);
}
function renderNotes() {
  const s = slides[index];
  el('notes-title').textContent = `${index + 1}/${slides.length} · ${s.id} · ${s.minutes}`;
  const body = el('notes-body');
  body.replaceChildren(...s.notes.map(n => make('p', n.includes('[NICK') ? 'nick' : '', n)));
}
setInterval(() => {
  const seconds = Math.floor((Date.now() - started) / 1000);
  el('notes-clock').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}, 1000);
document.addEventListener('keydown', e => {
  if (e.target instanceof Element && e.target.closest('input')) return;
  const k = e.key.toLowerCase();
  if (['arrowright', ' ', 'pagedown', 'enter'].includes(k)) {
    e.preventDefault();
    next();
  } else if (['arrowleft', 'pageup'].includes(k)) {
    e.preventDefault();
    prev();
  } else if (k === 'home') go(0);
  else if (k === 'end') go(slides.length - 1);
  else if (k === 'n') el('notes').hidden = !el('notes').hidden;
  else if (k === 'b') document.body.classList.toggle('brain-only');
  else if (k === 'f')
    void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  else if (k === 's' && slides[index].id === 'proof') go(index, step === 0 ? 1 : 0);
  else if ((k === 'a' || k === 'r') && slides[index].id.startsWith('round-')) {
    const r = rounds[Number(slides[index].id.slice(6)) - 1];
    if (r) {
      r.room = k === 'a' ? 'approve' : 'object';
      roundRenderers[Number(slides[index].id.slice(6)) - 1]();
    }
  }
});
// ?draw pre-draws the audience round, for rehearsal and screenshots.
if (new URLSearchParams(location.search).has('draw')) drawRounds();
/** #n or #n.step: slide n (1-based) at a step. Typing a hash jumps there. */
const fromHash = () => {
  const [at, sub] = location.hash.slice(1).split('.').map(Number);
  go(Number.isFinite(at) && at > 0 ? at - 1 : 0, sub || 0);
};
addEventListener('hashchange', fromHash);
fromHash();

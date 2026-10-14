import { BrainView } from './brain-view.js';
import { FlyModel } from './fly-model.js';
import { GLOMERULI } from '../src/review-odor.js';
import type { BrainAnatomy, ReviewFrame } from '../src/review-brain.js';

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
};
type Deck = {
  numbers: Numbers;
  receptors: { key: string; label: string; question: string; silenced: boolean }[];
  recordings: Record<string, Recording>;
  pool: Pick[];
  poolRule: string;
};
type Slide = {
  id: string;
  minutes: string;
  className?: string;
  steps?: number;
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
const drive = (d: typeof rest) => fly?.drive(override ? { ...d, ...override } : d);

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
  rounds = Array.from({ length: 3 }, () => ({
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
function verdictCard(who: string, call: 'approve' | 'object' | 'unsure' | null, why = '') {
  const card = make('div', `verdict ${call ?? ''}`);
  card.append(make('div', 'who', who));
  card.append(
    make(
      'div',
      'what',
      call === 'approve' ? 'Approve' : call === 'object' ? 'Changes requested' : call === 'unsure' ? 'Abstains' : '…',
    ),
  );
  if (why) card.append(make('div', 'why', why));
  return card;
}
function roundSlide(i: number): Slide {
  let host: HTMLElement;
  const render = () => {
    const r = rounds[i];
    host.replaceChildren();
    html(host, `<div class="kicker">Round ${i + 1} of 3</div>`);
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
            `recorded held-out vote · share ${r.pick.fly.share.toFixed(2)}${r.pick.fly.behavior === 'reached' ? ' · reached for it' : ''}`,
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
      'Step 2 (→): the fly’s vote. It is the recorded vote from the held-out test run; the fly is deterministic, so this is what it says every time.',
      'Step 3 (→): the tests. Green border = right.',
    ],
  };
}

const slides: Slide[] = [
  {
    id: 'title',
    minutes: '0:15',
    className: '',
    build: h =>
      html(
        h,
        `<div class="kicker">AI Engineer · New York</div><h1>Are You Smarter Than A Fruit Fly?</h1><p class="byline">Nick Nisi · WorkOS</p>`,
      ),
    enter: () => {
      home();
      play('naive');
    },
    notes: [
      '[NICK: intro line in your words.]',
      'Behind you: a real simulated fruit-fly brain, every point a measured neuron position.',
    ],
  },
  {
    id: 'live',
    minutes: '1:30',
    build: h => {
      html(
        h,
        `<div class="kicker">Live</div><h2>A fruit fly is about to review a pull request.</h2><p>176,422 simulated neurons, wired like a real fly’s: its nervous system, mapped neuron by neuron. About two seconds on this laptop.</p>`,
      );
      const row = make('div', 'row');
      const input = make('input', 'pr-input');
      input.placeholder = 'owner/repo#123';
      input.setAttribute('aria-label', 'Pull request to review live');
      const go = make('button', 'button primary', 'Ask the fly, live →');
      go.addEventListener('click', () => {
        if (input.value.trim()) location.href = `/#pr=${encodeURIComponent(input.value.trim())}`;
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') go.click();
      });
      const recorded = make('button', 'button', 'Plan B: a recorded run');
      recorded.addEventListener('click', () => {
        home();
        play('objects');
      });
      row.append(input, go, recorded);
      h.append(row);
      html(h, `<p class="caption">A pull request is never executed. The fly votes; nothing checks the vote.</p>`);
    },
    enter: () => {
      home();
      still();
    },
    notes: [
      'Ask someone in the room for an open-source PR, or have one ready. Small PRs are faster: each hunk is one Jev call, and a 32-hunk PR takes the simulation one to two minutes to read.',
      'Type it, Enter. The main page opens with the PR fetched; click Ask the fly. Come back with the browser’s back button.',
      'Wifi dies → “Plan B: a recorded run” plays a real recording of the fly catching a bug.',
      'If asked: the wiring map is a connectome, male-cns v1.0 from HHMI Janelia, Cambridge, and Google.',
      'Line to use, yours: “I like the idea of having your code reviewed by a fruit fly and the analogy that I’m so smooth-brained that it’s better at code review than me at this point.”',
    ],
  },
  {
    id: 'me',
    minutes: '0:20',
    className: 'wide',
    build: h =>
      html(
        h,
        `<div class="intro"><img class="headshot" src="/assets/nick-nisi.webp" alt="Nick Nisi" width="320" height="320" /><div><div class="kicker">Hi, I'm</div><h1>Nick Nisi</h1><p class="byline">Developer Experience Engineer at WorkOS</p><p class="caption">nicknisi.com</p></div></div>`,
      ),
    enter: () => applaud('.headshot'),
    notes: [
      '[NICK: who you are, in your words. Sourced candidates from your blog: Developer Experience Engineer at WorkOS (on the slide); seven years on JS Party.]',
      'The fly is applauding: the brain is a real recording of its grooming neuron firing after its antennae were touched, and flies rub their front legs together when they groom.',
    ],
  },
  {
    id: 'workos',
    minutes: '0:15',
    className: 'center',
    build: h =>
      html(
        h,
        `<img class="logo" src="/assets/workos-logo-white.svg" alt="WorkOS" width="880" height="168" /><p class="caption">workos.com</p>`,
      ),
    enter: () => applaud('.logo'),
    notes: ['[NICK: one line about WorkOS, in your words.]', 'Same real grooming recording; the fly keeps clapping.'],
  },
  {
    id: 'lgtm',
    minutes: '0:50',
    build: h =>
      html(
        h,
        `<div class="kicker">The problem</div>
        <blockquote>Reviewing code is the bottleneck. Humans aren't involved in writing it anymore and the functionality is what matters.</blockquote>
        <blockquote class="step later" data-step="1">It's a big trust issue for humans. Feels like giving up a lot of control but I think that humans are just as capable of slop as agents are.<cite>— me, this week</cite></blockquote>`,
      ),
    steps: 2,
    enter: () => still(),
    notes: [
      'Both quotes are yours, verbatim from the interview. Say them your way.',
      'Optional: one industry number about unreviewed or skimmed PRs. Source it before it goes on a slide.',
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
          `The smell lights up about 5% of its ${N.kenyonCells.toLocaleString()} memory cells. Similar code, similar cells.`,
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
      'One press per part; the fly acts each one out. The detail slides that follow are the same four, one at a time.',
      'If anyone asks for the real names: the smell channels are glomeruli, the memory cells are Kenyon cells in the mushroom body, the two output groups are MBONs, the tongue is the proboscis.',
      'For this room, optional: the fly’s smell circuit has been described as locality-sensitive hashing (Dasgupta, Stevens & Navlakha, Science, 2017).',
    ],
  },
  {
    id: 'nose',
    minutes: '0:45',
    className: 'wide',
    steps: 2,
    build: h => {
      const rec = deck.recordings.objects;
      html(h, `<div class="kicker">1 · The nose</div><h2>Step 1: turn the diff into a smell.</h2>`);
      html(
        h,
        `<p>Jev, an AI model, answers thirty yes-or-no questions about <strong>what changed</strong>. None asks whether the change is good. The two that ask whether it changes the result are switched off: that’s the tests’ job.</p>`,
      );
      const chips = make('div', 'receptors');
      deck.receptors.forEach((r, i) => {
        const lit = (rec.stimuli[`odor:${GLOMERULI[i]}`] ?? 0) > 0;
        const chip = make('span', `receptor ${r.silenced ? 'silenced' : lit ? 'lit' : ''}`, r.label);
        chip.title = r.question;
        chips.append(chip);
      });
      h.append(chips);
      const odor = make('div', 'odor step later');
      odor.dataset.step = '1';
      GLOMERULI.forEach((g, i) => {
        const bar = make('i', i < deck.receptors.length ? '' : 'lexical');
        bar.dataset.height = String(Math.min(100, ((rec.stimuli[`odor:${g}`] ?? 0) / 150) * 100));
        odor.append(bar);
      });
      h.append(odor);
      html(
        h,
        `<p class="caption step later" data-step="1">The answers, plus the words in the changed lines, become ${N.glomeruli} numbers: a smell. Violet from Jev, yellow from the words. Same change, same smell, every time. This one is “${rec.review!.title}”.</p>`,
      );
    },
    enter: step => {
      still();
      home();
      for (const bar of document.querySelectorAll<HTMLElement>('.odor i'))
        bar.style.height = step >= 1 ? `${Math.max(4, Number(bar.dataset.height))}%` : '4%';
    },
    notes: [
      'Lit chips are what Jev said about this change (above 25%). Struck-through red chips are the two the fly never smells.',
      '→ the smell: one bar per smell channel (a glomerulus, if asked).',
    ],
  },
  {
    id: 'memory',
    minutes: '0:40',
    build: h =>
      html(
        h,
        `<div class="kicker">2 · The memory</div><h2>Step 2: the smell lights up a few of ${N.kenyonCells.toLocaleString()} memory cells.</h2><p>Each violet dot is a memory cell, where it sits in a real fly’s brain. Every one is wired to two groups of output neurons, <strong class="red">avoid</strong> and <strong class="green">approach</strong>. Those wires are the memory.</p><p class="caption">Similar code lights up similar cells: two unrelated smells share about 1% of them, two that share a channel about 40%.</p>`,
      ),
    enter: () => {
      view.focusMushroomBody(true);
      play('objects');
    },
    notes: [
      'The camera swoops onto the fly’s memory center (the mushroom body). This is a real recording, bins of 25 ms slowed down. The readout strip at the bottom left is live from the recording.',
      'If asked: memory cells are Kenyon cells; the output neurons are MBONs. Each smell lights the 5% of each cell type it drives hardest.',
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
        <p data-step="1" class="step later">A test proves the change harmless: <strong>sugar</strong>. Reward dopamine fires (${Math.round(deck.recordings.sugar.pamHz)} Hz), weakens their wires to <strong class="red">avoid</strong>, and the tongue comes out.</p>
        <blockquote class="step later" data-step="1">I tried to train the fly on the codebase by using mutation testing to identify good and bad parts of the code and then train the fly to have memories based on that.</blockquote>
        <p class="caption">${N.lessons} lessons. Every label proven by running code: mutants that real test suites killed in authkit-nextjs, authkit-js, and ufo. “No bug found” teaches nothing.</p>`,
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
        `<div class="kicker">4 · The vote</div><h2>Step 4: tongue out means approve.</h2>
        <p class="step" data-step="0">A harmless change. The smell alone brings its tongue out: <strong>the fly reached for it</strong>. Approve. (${deck.recordings.reaches.review!.title})</p>
        <p class="step later" data-step="1">A real bug. <strong class="red">Avoid</strong> drowns out <strong class="green">approach</strong> and the tongue stays in: <strong>changes requested</strong>. Too close to call, it abstains. (${deck.recordings.objects.review!.title})</p>`,
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
    id: 'proof',
    minutes: '0:50',
    className: 'wide',
    steps: 2,
    build: h => {
      html(
        h,
        `<div class="kicker">The ablation</div><h2>Is it the fly, or is the AI nose doing the work?</h2><p>Keep the nose and the lessons. Shuffle only which output neurons the teacher’s dopamine reaches.</p>`,
      );
      const duel = make('div', 'duel');
      duel.innerHTML = `<div class="good" data-side="real"><div class="kicker">Real wiring</div><div class="num">${N.caught[0]}<small> / ${N.caught[1]}</small></div><p>bugs caught</p></div>
        <div class="bad dim" data-side="scrambled"><div class="kicker">Scrambled</div><div class="num">${N.shuffled.caught[0]}<small> / ${N.shuffled.caught[1]}</small></div><p>bugs caught · ${N.shuffled.bugsApproved} approved</p></div>`;
      h.append(duel);
      html(
        h,
        `<p class="caption">An untrained fly gets ${N.naiveAgree} of ${N.heldOut} right. Nothing upstream of the fly knows whether a change broke anything. Press S to switch.</p>`,
      );
    },
    enter: step => {
      home();
      play(step === 0 ? 'objects' : 'scrambled');
      document.querySelector('[data-side="real"]')?.classList.toggle('dim', step !== 0);
      document.querySelector('[data-side="scrambled"]')?.classList.toggle('dim', step === 0);
    },
    notes: [
      '→ scrambles. Same bug, same smell: with scrambled wiring the fly reaches for it. Degrees preserved; only who-talks-to-whom changed.',
    ],
  },
  {
    id: 'game',
    minutes: '0:30',
    className: 'center',
    build: h => {
      html(
        h,
        `<div class="kicker">Audience round</div><h1>Are you smarter than a fruit fly?</h1><p>Three real changes. Hands up: approve or request changes. Then the fly. Then the tests.</p>`,
      );
      const draw = make('button', 'button primary', 'Draw three changes');
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
  roundSlide(2),
  {
    id: 'numbers',
    minutes: '0:50',
    className: 'wide',
    build: h => {
      html(h, `<div class="kicker">The whole exam</div><h2>${N.heldOut} changes it had never seen.</h2>`);
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
        `<p>When it votes, it’s right <strong>${N.agree} of ${N.votes}</strong>. ${N.abstained} times it says it doesn’t know. ${N.bugsApproved} bugs it waved through. Balanced accuracy: the average of bugs caught and harmless changes approved.</p>`,
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
      '“A spreadsheet” is a logistic regression reading the exact same smell. “Best single clue” is the one smell channel that does best alone. Both fit on the same training lessons.',
      'The room bar is three questions, not ' + N.heldOut + '. Say so.',
    ],
  },
  {
    id: 'miss',
    minutes: '0:45',
    className: 'wide',
    build: h => {
      const rec = deck.recordings.missed;
      html(h, `<div class="kicker">What it gets wrong</div><h2>It reaches for real bugs.</h2>`);
      if (rec) {
        h.append(diffBox(rec.review!));
        html(h, `<p>“${rec.review!.title}”: a test reproduces this bug. The fly reaches for it anyway.</p>`);
      }
      const prs = N.prs.filter(p => /#(35|249)$/.test(p.pr));
      html(
        h,
        `<p class="caption">${prs.map(p => `${p.pr}: ${p.verdict.replace('_', ' ')}`).join(' · ')}. Both were later reverted.</p>`,
      );
    },
    enter: () => {
      home();
      play('missed');
    },
    notes: [
      'The fly approves the rounding bug and reaches for it. On real PRs it flagged #35 and let #249 through; both were reverted.',
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
      '→ the why. Your line: “Agents can verify that it’s logically correct but we need to make sure that it makes sense for the use case or the application.”',
    ],
  },
  {
    id: 'proposal',
    minutes: '1:45',
    className: 'wide',
    steps: 6,
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
        `<blockquote class="step later" data-step="1">…having them maintain a skill, for lack of a better term, that is how that team would do code reviews.</blockquote>`,
      );
    },
    enter: step => {
      still();
      document.querySelectorAll('.slide.on .station').forEach((s, i) => s.classList.toggle('active', step - 1 === i));
      el('fly').classList.add('station-seat');
    },
    notes: [
      'Your proposal, verbatim: “…having individual teams where we might have code owners before that are assigned to it, having them maintain a skill, for lack of a better term, that is how that team would do code reviews. Along with some like classification, potentially with Jev or other models that can decide whether something is too complex, or if it fails the team’s automated review system, then it gets escalated to a human to review in a summarized way, where they’re focusing on just the business logic or just the bits that actually make sense.”',
      '→ walks a PR through, one station per press. The fly sits on “Automated review”.',
    ],
  },
  {
    id: 'evidence',
    minutes: '0:45',
    build: h => {
      html(h, `<div class="kicker">What the agent hands the human</div><h2>Evidence and a receipt.</h2>`);
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
      h.append(receipts);
      html(h, `<blockquote>…what the code is doing and why, and specifically why not other methods.</blockquote>`);
    },
    enter: () => {
      still();
    },
    notes: ['The list and the quote are yours (interview, and the Sept 18 pitch).'],
  },
  {
    id: 'bridge',
    minutes: '0:45',
    className: 'wide',
    build: h => {
      html(h, `<div class="kicker">The fly is the dumbest version of this</div>`);
      const table = make('table', 'bridge');
      table.innerHTML = `<thead><tr><th>The proposal</th><th>The fly</th></tr></thead><tbody></tbody>`;
      const rows: [string, string][] = [
        [
          'A team-owned review skill',
          'A memory learned from that repo’s own test suite (203 mutants of authkit-nextjs)',
        ],
        ['A classifier', 'Jev describes; it never judges'],
        ['The team’s automated review', 'Only executed evidence teaches'],
        ['Escalate to a human', `The fly abstains: ${N.abstained} of ${N.heldOut}`],
        [
          'A summarized human review',
          'Where it looks: the hunk unlike the rest. #249 is the warning: the bug was in the hunks it tuned out.',
        ],
      ];
      for (const [a, b] of rows) {
        const tr = make('tr');
        tr.append(make('td', '', a), make('td', '', b));
        table.querySelector('tbody')!.append(tr);
      }
      h.append(table);
    },
    enter: () => {
      still();
    },
    notes: [
      '[NICK: confirm this mapping is the point you want. It is a structural read of the facts, not your framing yet.]',
    ],
  },
  {
    id: 'close',
    minutes: '0:30',
    className: 'center',
    build: h => html(h, `<div class="url">fruitfly.review</div><p>Run it on your own pull request.</p>`),
    enter: () => {
      home();
      el('fly').classList.remove('station-seat');
      play('reaches');
    },
    notes: ['[NICK: closing line, in your words.]'],
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
  if (fly && !['me', 'workos'].includes(slides[index].id)) {
    fly.groomStyle = 'sweep';
    fly.face(null);
  }
  if (slides[index].id !== 'question') flown = false;
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

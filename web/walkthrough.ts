/**
 * An interactive walkthrough that runs on the real page: a spotlight moves from the actual brain to the actual diff to the
 * actual verdict, and each stop carries a small animated scene that breaks one idea down. Where the page can do the
 * demonstration itself (swoop onto the mushroom body, lean the fly, wait for a real vote) it does; the drawings only stand in
 * for what cannot be seen at page scale, and every number in them comes from the run on screen when there is one.
 */
import type { ReviewState } from '../src/review-types.js';
import { RECEPTORS, odorEntries } from '../src/review-odor.js';
import type { Drive } from './fly.js';

export type TourContext = {
  state: () => ReviewState | null;
  onState: (listener: (s: ReviewState) => void) => () => void;
  focusMushroomBody: (on: boolean) => void;
  leanFly: (drive: Partial<Drive> | null) => void;
  askTheFly: () => HTMLButtonElement;
  /** Other real controls the card can stand in for while the page is inert. */
  control: (id: 'verify' | 'recall' | 'forget') => HTMLButtonElement | null;
  /** The billing / readiness note under the real Ask button, mirrored beside the proxy. */
  readiness: () => string;
};

type Scene = { cleanup?: () => void };
type Step = {
  target: () => Element | null;
  title: (s: ReviewState | null) => string;
  body: (s: ReviewState | null) => string;
  scene?: (s: ReviewState | null, host: HTMLElement, extra: HTMLElement) => Scene | void;
  enter?: () => void;
  exit?: () => void;
  /** An interactive stop: the tour waits for the page to do something real, then moves on by itself. */
  waitFor?: (s: ReviewState) => boolean;
  padding?: number;
};

const NS = 'http://www.w3.org/2000/svg';
const VIEW = { w: 340, h: 150 };
const TEAMS = { avoid: 'back away', approach: 'come closer' };
const DEMO_LABELS = ['changes a comparison', 'removes a conditional', 'touches credentials'];

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const child of children) node.append(child);
  return node;
}
const scene = (label: string) =>
  svg('svg', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'img', 'aria-label': label, class: 'tour-svg' });
const stagger = (node: Element, i: number) => (node as unknown as HTMLElement).style.setProperty('--i', String(i));
const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
const hz = (n: number) => `${Math.round(n)} Hz`;

function noticed(s: ReviewState | null): string[] {
  if (!s?.features) return DEMO_LABELS;
  const f = s.features;
  const top = RECEPTORS.filter(r => f[r.key] >= 0.5)
    .sort((a, b) => f[b.key] - f[a.key])
    .slice(0, 3)
    .map(r => lower(r.label));
  return top.length ? top : DEMO_LABELS;
}
function balance(s: ReviewState | null): { avoid: number; approach: number; share: number; real: boolean } {
  const b = s?.brain;
  if (b && b.avoidHz + b.approachHz >= 20)
    return { avoid: b.avoidHz, approach: b.approachHz, share: b.avoidHz / (b.avoidHz + b.approachHz), real: true };
  return { avoid: 96, approach: 78, share: 0.55, real: false };
}

/* Scene 1: Jev sniffs the diff and hands back descriptions, never a verdict. */
function sniffScene(labels: string[]): SVGSVGElement {
  const root = scene('A code change is sniffed by Jev, which hands back three plain descriptions of it.');
  const code = svg('g', { class: 'code' });
  code.append(svg('rect', { x: 8, y: 22, width: 108, height: 106, rx: 6, class: 'code-bg' }));
  const widths = [60, 84, 48, 76, 66];
  widths.forEach((w, i) => {
    const kind = i === 2 ? 'removed' : i === 3 ? 'added' : 'plain';
    code.append(svg('rect', { x: 20, y: 34 + i * 19, width: w, height: 7, rx: 2, class: `code-line ${kind}` }));
  });
  root.append(code);
  const jev = svg('g', { class: 'jev', transform: 'translate(176 75)' });
  for (let i = 0; i < 3; i++) {
    const ring = svg('circle', { r: 26, class: 'sniff' });
    stagger(ring, i);
    jev.append(ring);
  }
  jev.append(
    svg('circle', { r: 26, class: 'jev-body' }),
    svg('text', { y: 4, 'text-anchor': 'middle', class: 'jev-label' }, 'Jev'),
    svg('text', { y: 44, 'text-anchor': 'middle', class: 'caption' }, 'the nose'),
  );
  root.append(jev);
  labels.forEach((label, i) => {
    const at = svg('g', { transform: `translate(218 ${28 + i * 40})` });
    const chip = svg('g', { class: 'chip' });
    stagger(chip, i);
    const text = svg(
      'text',
      { x: 10, y: 15, class: 'chip-label' },
      label.length > 22 ? `${label.slice(0, 21)}…` : label,
    );
    chip.append(svg('rect', { width: 116, height: 24, rx: 6, class: 'chip-bg' }), text);
    at.append(chip);
    root.append(at);
  });
  return root;
}

/* Scene 2: fifty-three scents rise, then wake a sparse handful of memory cells. */
function smellScene(s: ReviewState | null): SVGSVGElement {
  const root = scene('Fifty-three scent bars rise, then a few of many memory cells light up.');
  const entries = odorEntries(s?.odor ?? {});
  const demo = !s?.odor;
  const rates = entries.map((e, i) =>
    demo ? (i % 7 === 0 || i % 11 === 3 ? 0.45 + ((i * 37) % 50) / 100 : 0) : e.hz / 150,
  );
  rates.forEach((r, i) => {
    const h = r > 0 ? 6 + r * 44 : 2;
    const bar = svg('rect', {
      x: 12 + i * 6,
      y: 58 - h,
      width: 4,
      height: h,
      rx: 1,
      class: `bar ${r > 0 ? (entries[i].receptor ? 'receptor' : 'lexical') : 'quiet'}`,
    });
    stagger(bar, i);
    root.append(bar);
  });
  root.append(svg('line', { x1: 12, y1: 60, x2: 328, y2: 60, class: 'baseline' }));
  const cols = 26,
    rows = 5,
    active = s?.brain?.activeKenyon ?? 203;
  const lit = new Set<number>();
  // About 5% of the grid, chosen from the odor so the same smell always lights the same cells in the drawing.
  const seed = rates.reduce((a, r, i) => a + Math.round(r * 100) * (i + 1), 7);
  for (let k = 0; lit.size < Math.max(6, Math.round(cols * rows * 0.05)); k++)
    lit.add((seed * (k + 1) * 7919) % (cols * rows));
  let n = 0;
  for (let i = 0; i < cols * rows; i++) {
    const dot = svg('circle', {
      cx: 16 + (i % cols) * 12.2,
      cy: 84 + Math.floor(i / cols) * 13,
      r: 2.2,
      class: `cell ${lit.has(i) ? 'lit' : ''}`,
    });
    if (lit.has(i)) stagger(dot, n++);
    root.append(dot);
  }
  root.append(
    svg(
      'text',
      { x: 328, y: 147, 'text-anchor': 'end', class: 'caption' },
      `${active.toLocaleString()} of 4,064 cells wake`,
    ),
  );
  return root;
}

/* Scene: a diff read hunk by hunk. First reading tall, second reading only the odd one stays up. */
function hunksScene(s: ReviewState | null): SVGSVGElement {
  const a = s?.attention;
  const units = a
    ? a.units.map(u => ({ first: u.reading.naiveNoveltyHz, second: u.reading.noveltyHz, looked: u.index === a.looked }))
    : [0, 1, 2, 3, 4, 5].map(i => ({
        first: 9 + (i % 3),
        second: i === 3 ? 6 : i === 0 ? 2 : i % 2 ? 1 : 0,
        looked: i === 3,
      }));
  const shown = units.slice(0, 16);
  const root = scene(
    `${shown.length} hunks as pairs of bars: what each evoked on first exposure, and what it still evoked on the second reading. One stays up.`,
  );
  const max = Math.max(1, ...shown.flatMap(u => [u.first, u.second]));
  const slot = Math.min(36, 300 / shown.length),
    w = Math.max(4, slot * 0.32);
  shown.forEach((u, i) => {
    const x = 20 + i * slot;
    const h1 = 4 + (u.first / max) * 74,
      h2 = 2 + (u.second / max) * 74;
    const first = svg('rect', { x, y: 104 - h1, width: w, height: h1, rx: 1, class: 'bar first-read' });
    const second = svg('rect', {
      x: x + w + 2,
      y: 104 - h2,
      width: w,
      height: h2,
      rx: 1,
      class: `bar second-read${u.looked ? ' looked' : ''}`,
    });
    stagger(first, i);
    stagger(second, i + shown.length);
    root.append(first, second);
    if (u.looked)
      root.append(
        svg('text', { x: x + w + 1, y: 104 - h2 - 6, 'text-anchor': 'middle', class: 'caption looked' }, 'here'),
      );
  });
  root.append(svg('line', { x1: 12, y1: 105, x2: 328, y2: 105, class: 'baseline' }));
  root.append(svg('text', { x: 12, y: 126, class: 'caption' }, 'first reading'));
  root.append(svg('rect', { x: 76, y: 118, width: 8, height: 8, class: 'bar first-read still' }));
  root.append(svg('text', { x: 96, y: 126, class: 'caption' }, 'second reading'));
  root.append(svg('rect', { x: 170, y: 118, width: 8, height: 8, class: 'bar second-read still' }));
  if (!a)
    root.append(svg('text', { x: 328, y: 146, 'text-anchor': 'end', class: 'caption faint' }, 'illustrative numbers'));
  else if (a.units.length > shown.length)
    root.append(
      svg(
        'text',
        { x: 328, y: 146, 'text-anchor': 'end', class: 'caption faint' },
        `first ${shown.length} of ${a.units.length}`,
      ),
    );
  return root;
}

/* Scene 3: two teams pull on the vote; the knot's position is the real share. */
type Tug = {
  root: SVGSVGElement;
  moveTo(share: number, note?: string): void;
  shout(avoid: number, approach: number): void;
};
function tugScene(avoid: number, approach: number, share: number, illustrative = false): Tug {
  const root = scene(`Two teams pull a rope: back away at ${hz(avoid)}, come closer at ${hz(approach)}.`);
  const x0 = 74,
    x1 = 266,
    y = 84;
  const at = (p: number) => x0 + p * (x1 - x0);
  root.append(svg('line', { x1: x0, y1: y, x2: x1, y2: y, class: 'rope' }));
  if (illustrative)
    root.append(svg('text', { x: 330, y: 146, 'text-anchor': 'end', class: 'caption faint' }, 'illustrative numbers'));
  for (const [p, label, side] of [
    [0.45, 'no objection', 'start'],
    [0.68, 'changes requested', 'end'],
  ] as const) {
    root.append(
      svg('line', { x1: at(p), y1: y - 12, x2: at(p), y2: y + 12, class: 'tick' }),
      svg('text', { x: at(p), y: y + 30, 'text-anchor': side === 'start' ? 'end' : 'start', class: 'caption' }, label),
    );
  }
  root.append(
    svg('line', { x1: at(0.5), y1: y - 16, x2: at(0.5), y2: y - 8, class: 'tick' }),
    svg('text', { x: at(0.5), y: y - 22, 'text-anchor': 'middle', class: 'caption faint' }, 'even'),
  );
  const team = (cx: number, cls: 'avoid' | 'approach', rate: number) => {
    const g = svg('g', { class: `team ${cls}` });
    [-19, 0, 19].forEach((dy, i) => {
      const c = svg('circle', { cx, cy: y + dy, r: 7, class: 'puller' });
      stagger(c, i);
      g.append(c);
    });
    g.append(
      svg('text', { x: cx, y: y - 34, 'text-anchor': 'middle', class: 'team-label' }, TEAMS[cls]),
      svg('text', { x: cx, y: y + 44, 'text-anchor': 'middle', class: 'caption rate' }, hz(rate)),
    );
    return g;
  };
  const left = team(38, 'avoid', avoid),
    right = team(302, 'approach', approach);
  root.append(left, right);
  const knot = svg('g', { class: 'knot' });
  knot.append(svg('circle', { r: 9, class: 'knot-body' }), svg('circle', { r: 3.2, class: 'knot-core' }));
  const note = svg('text', { x: at(0.5), y: 16, 'text-anchor': 'middle', class: 'caption note' }, '');
  root.append(knot, note);
  let current = 0.5;
  const place = (p: number) => {
    knot.setAttribute('transform', `translate(${at(p)} ${y})`);
    current = p;
  };
  place(0.5);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shout = (a: number, b: number) => {
    for (const [g, rate] of [
      [left, a],
      [right, b],
    ] as const) {
      g.querySelector('.rate')!.textContent = hz(rate);
      (g as unknown as HTMLElement).style.setProperty(
        '--period',
        `${Math.max(0.28, 40 / Math.max(rate, 1)).toFixed(2)}s`,
      );
      g.classList.toggle('winning', rate > 1.2 * (g === left ? b : a));
    }
  };
  shout(avoid, approach);
  const moveTo = (p: number, text = '') => {
    note.textContent = text;
    if (reduce) return place(p);
    const from = current,
      start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 900),
        e = 1 - Math.pow(1 - k, 4);
      place(from + (p - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  setTimeout(() => moveTo(share), reduce ? 0 : 350);
  return { root, moveTo, shout };
}

/* Scene 4: dopamine. Bitter on the tongue fires the punishment neurons and thins the wires to "come closer"; sugar fires the reward neurons and thins the wires to "back away". */
function zapScene(mode: 'punish' | 'reward'): SVGSVGElement {
  const root = scene(
    mode === 'punish'
      ? 'A bitter drop lands on its tongue, its punishment neurons fire, and the wires from the lit memory cells to the come-closer team thin out.'
      : 'A sugar cube lands on its tongue, its reward neurons fire, and the wires from the lit memory cells to the back-away team thin out.',
  );
  const cells = [24, 46, 68, 90, 112, 134].map(cy => ({ cx: 46, cy }));
  const nodes = { avoid: { cx: 246, cy: 44 }, approach: { cx: 246, cy: 108 } };
  const weakened = mode === 'punish' ? 'approach' : 'avoid';
  cells.forEach((c, i) => {
    for (const side of ['avoid', 'approach'] as const) {
      const line = svg('line', {
        x1: c.cx + 8,
        y1: c.cy,
        x2: nodes[side].cx - 14,
        y2: nodes[side].cy,
        class: `wire ${side === weakened ? 'weaken' : ''}`,
      });
      stagger(line, i);
      root.append(line);
    }
  });
  cells.forEach((c, i) => {
    const dot = svg('circle', { cx: c.cx, cy: c.cy, r: 6, class: 'cell lit steady' });
    stagger(dot, i);
    root.append(dot);
  });
  root.append(svg('text', { x: 10, y: 148, class: 'caption' }, 'cells that carried the smell'));
  for (const side of ['avoid', 'approach'] as const) {
    const n = nodes[side];
    root.append(
      svg('circle', { cx: n.cx, cy: n.cy, r: 12, class: `node ${side} ${side === weakened ? 'starved' : ''}` }),
      svg('text', { x: n.cx + 18, y: n.cy + 4, class: 'team-label' }, TEAMS[side]),
    );
  }
  if (mode === 'punish') {
    const drop = svg('path', {
      d: 'M212 62 C 204 76, 198 84, 198 94 a14 14 0 0 0 28 0 c0 -10 -6 -18 -14 -32 z',
      class: 'bolt',
    });
    root.append(drop, svg('text', { x: 212, y: 126, 'text-anchor': 'middle', class: 'caption note' }, 'bitter'));
  } else {
    const at = svg('g', { transform: 'translate(203 16)' });
    const cube = svg('g', { class: 'treat' });
    cube.append(
      svg('rect', { width: 18, height: 18, rx: 2, class: 'cube' }),
      svg('rect', { x: 3, y: 3, width: 6, height: 4, rx: 1, class: 'cube-shine' }),
    );
    at.append(cube);
    root.append(at, svg('text', { x: 212, y: 48, 'text-anchor': 'middle', class: 'caption note' }, 'sugar'));
  }
  return root;
}

/* Scene 5: two runs of the same smell on the same fly draw the same spikes, to the bit. */
function sameScene(): SVGSVGElement {
  const root = scene('Two identical rows of spikes and a check mark: the same smell gives the same answer.');
  const spikes = [0.05, 0.09, 0.16, 0.19, 0.27, 0.33, 0.36, 0.44, 0.51, 0.58, 0.62, 0.7, 0.77, 0.81, 0.9, 0.95];
  [40, 92].forEach((y, row) => {
    root.append(svg('text', { x: 12, y: y + 4, class: 'caption' }, row === 0 ? 'run 1' : 'run 2'));
    root.append(svg('line', { x1: 50, y1: y, x2: 290, y2: y, class: 'baseline' }));
    spikes.forEach((p, i) => {
      const x = 50 + p * 240;
      const tick = svg('line', { x1: x, y1: y - 14, x2: x, y2: y + 14, class: `spike row-${row}` });
      stagger(tick, i);
      root.append(tick);
    });
  });
  root.append(
    svg('path', { d: 'M300 62 l9 9 l19 -22', class: 'check' }),
    svg('text', { x: 170, y: 140, 'text-anchor': 'middle', class: 'caption' }, 'same smell · same fly · same memory'),
  );
  return root;
}

export class Walkthrough {
  private root: HTMLDivElement | null = null;
  private veil!: SVGPathElement;
  private ring!: SVGRectElement;
  private card!: HTMLElement;
  private index = 0;
  private hole = { x: 0, y: 0, w: 0, h: 0 };
  private tween: number | null = null;
  private cleanups: (() => void)[] = [];
  private readonly reduce = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly steps: Step[];
  private lastFocus: Element | null = null;
  /** Page regions made inert while the tour is open, with their prior flags, restored on close before focus returns. */
  private inerted: { el: HTMLElement; was: boolean }[] = [];

  constructor(private readonly ctx: TourContext) {
    this.steps = this.buildSteps();
  }

  start(at = 0) {
    if (!this.root) this.mount();
    this.lastFocus = document.activeElement;
    this.go(Math.max(0, Math.min(at, this.steps.length - 1)), true);
  }
  close() {
    if (!this.root) return;
    this.leave();
    this.root.remove();
    this.root = null;
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
    for (const { el, was } of this.inerted.splice(0)) el.inert = was;
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  private mount() {
    const root = document.createElement('div');
    root.className = `tour ${this.reduce.matches ? 'reduce' : ''}`;
    const veilSvg = svg('svg', { class: 'tour-veil', 'aria-hidden': 'true' });
    this.veil = svg('path', { 'fill-rule': 'evenodd', class: 'tour-shade' });
    this.ring = svg('rect', { class: 'tour-ring', rx: 10 });
    veilSvg.append(this.veil, this.ring);
    const card = document.createElement('article');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tour-title');
    card.setAttribute('aria-describedby', 'tour-body');
    card.innerHTML = `
      <button class="tour-skip" type="button" aria-label="Close the walkthrough">Skip</button>
      <p class="tour-status sr-only" role="status" aria-live="polite"></p>
      <div class="tour-scene" aria-hidden="false"></div>
      <h3 id="tour-title"></h3>
      <p class="tour-body" id="tour-body"></p>
      <div class="tour-extra"></div>
      <footer>
        <ol class="tour-dots" aria-label="Walkthrough progress"></ol>
        <div class="tour-nav">
          <button class="tour-back quiet" type="button">Back</button>
          <button class="tour-next primary" type="button">Next</button>
        </div>
      </footer>`;
    const dots = card.querySelector('.tour-dots')!;
    this.steps.forEach((_, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Step ${i + 1}`);
      b.addEventListener('click', () => this.go(i));
      li.append(b);
      dots.append(li);
    });
    card.querySelector('.tour-skip')!.addEventListener('click', () => this.close());
    card.querySelector('.tour-back')!.addEventListener('click', () => this.go(this.index - 1));
    card
      .querySelector('.tour-next')!
      .addEventListener('click', () => (this.index === this.steps.length - 1 ? this.close() : this.go(this.index + 1)));
    card.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowRight') this.go(this.index + 1);
      else if (e.key === 'ArrowLeft') this.go(this.index - 1);
      else if (e.key === 'Tab') {
        const focusable = [...card.querySelectorAll<HTMLElement>('button:not([disabled])')];
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    });
    root.append(veilSvg, card);
    // Genuinely modal: everything else on the page is inert while the tour is open. The spotlight stays visual, and the
    // card carries proxies for the real controls a step needs.
    this.inerted = [...document.body.children]
      .filter((el): el is HTMLElement => el instanceof HTMLElement && !(el instanceof HTMLScriptElement))
      .map(el => ({ el, was: el.inert }));
    for (const { el } of this.inerted) el.inert = true;
    document.body.append(root);
    this.root = root;
    this.card = card;
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
  }

  private leave() {
    for (const fn of this.cleanups.splice(0)) fn();
  }

  private go(index: number, immediate = false) {
    if (!this.root || index < 0 || index >= this.steps.length) return;
    this.leave();
    this.index = index;
    const step = this.steps[index],
      s = this.ctx.state();
    const card = this.card;
    card.querySelector('h3')!.textContent = step.title(s);
    card.querySelector('.tour-body')!.innerHTML = step.body(s);
    const host = card.querySelector<HTMLElement>('.tour-scene')!,
      extra = card.querySelector<HTMLElement>('.tour-extra')!;
    host.replaceChildren();
    extra.replaceChildren();
    if (step.scene) {
      const built = step.scene(s, host, extra);
      if (built?.cleanup) this.cleanups.push(built.cleanup);
    }
    host.hidden = !host.childElementCount;
    extra.hidden = !extra.childElementCount;
    step.enter?.();
    if (step.exit) this.cleanups.push(step.exit);
    // An interactive stop waits for the page, then redraws itself around what actually happened.
    if (step.waitFor && !(s && step.waitFor(s))) {
      const off = this.ctx.onState(next => {
        if (step.waitFor!(next)) {
          off();
          setTimeout(() => this.index === index && this.go(index), 700);
        }
      });
      this.cleanups.push(off);
    }
    card.querySelector('.tour-status')!.textContent = `Step ${index + 1} of ${this.steps.length}: ${step.title(s)}`;
    card.querySelectorAll('.tour-dots li').forEach((li, i) => {
      li.classList.toggle('current', i === index);
      const dot = li.querySelector('button')!;
      if (i === index) dot.setAttribute('aria-current', 'step');
      else dot.removeAttribute('aria-current');
    });
    card.querySelector<HTMLButtonElement>('.tour-back')!.disabled = index === 0;
    card.querySelector('.tour-next')!.textContent = index === this.steps.length - 1 ? 'Done' : 'Next';
    card.dataset.step = String(index);
    const target = step.target();
    if (target && !this.inView(target)) {
      target.scrollIntoView({ block: 'center', behavior: this.reduce.matches ? 'auto' : 'smooth' });
      setTimeout(() => this.aim(step, false), 480);
    }
    this.aim(step, immediate);
    card.querySelector<HTMLButtonElement>('.tour-next')!.focus({ preventScroll: true });
  }

  private inView(el: Element) {
    const r = el.getBoundingClientRect();
    return r.top >= 72 && r.bottom <= innerHeight - 24 && r.height < innerHeight - 96;
  }

  private reposition = () => {
    if (!this.root) return;
    this.aim(this.steps[this.index], true);
  };

  /** Move the spotlight onto the step's target and park the card beside it. */
  private aim(step: Step, immediate: boolean) {
    const target = step.target();
    const pad = step.padding ?? 10;
    const r = target?.getBoundingClientRect();
    const hole = r
      ? { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
      : { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 };
    if (this.tween) cancelAnimationFrame(this.tween);
    if (immediate || this.reduce.matches || !this.hole.w) this.setHole(hole);
    else {
      const from = { ...this.hole },
        start = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - start) / 420),
          e = 1 - Math.pow(1 - k, 5);
        this.setHole({
          x: from.x + (hole.x - from.x) * e,
          y: from.y + (hole.y - from.y) * e,
          w: from.w + (hole.w - from.w) * e,
          h: from.h + (hole.h - from.h) * e,
        });
        if (k < 1) this.tween = requestAnimationFrame(tick);
      };
      this.tween = requestAnimationFrame(tick);
    }
    this.placeCard(hole);
  }

  private setHole(h: { x: number; y: number; w: number; h: number }) {
    this.hole = h;
    const W = innerWidth,
      H = innerHeight,
      r = Math.min(10, h.w / 2, h.h / 2);
    const inner =
      h.w > 0
        ? `M${h.x + r} ${h.y}h${h.w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h.h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${h.w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h.h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`
        : '';
    this.veil.setAttribute('d', `M0 0H${W}V${H}H0Z ${inner}`);
    this.ring.setAttribute('x', String(h.x));
    this.ring.setAttribute('y', String(h.y));
    this.ring.setAttribute('width', String(Math.max(0, h.w)));
    this.ring.setAttribute('height', String(Math.max(0, h.h)));
    this.ring.classList.toggle('hidden', h.w === 0);
  }

  private placeCard(hole: { x: number; y: number; w: number; h: number }) {
    const card = this.card,
      m = 16,
      gap = 18;
    const cw = card.offsetWidth,
      ch = card.offsetHeight;
    const W = innerWidth,
      H = innerHeight;
    let x: number, y: number;
    if (hole.w === 0) {
      x = (W - cw) / 2;
      y = (H - ch) / 2;
    } else if (hole.x + hole.w + gap + cw + m <= W) {
      x = hole.x + hole.w + gap;
      y = hole.y + hole.h / 2 - ch / 2;
    } else if (hole.x - gap - cw >= m) {
      x = hole.x - gap - cw;
      y = hole.y + hole.h / 2 - ch / 2;
    } else if (hole.y + hole.h + gap + ch + m <= H) {
      x = hole.x + hole.w / 2 - cw / 2;
      y = hole.y + hole.h + gap;
    } else if (hole.y - gap - ch >= m) {
      x = hole.x + hole.w / 2 - cw / 2;
      y = hole.y - gap - ch;
    } else {
      x = W - cw - m;
      y = H - ch - m;
    }
    x = Math.max(m, Math.min(W - cw - m, x));
    y = Math.max(m, Math.min(H - ch - m, y));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /**
   * A stand-in for a real page control. It mirrors the real button's enabled state (and, when given, the readiness
   * note beside it) on every state update, so a proxy is never live when the page would refuse, and comes back after
   * an error. Clicking it clicks the real control; inert only blocks user events, not scripted ones.
   */
  private proxy(extra: HTMLElement, label: string, real: () => HTMLButtonElement | null, note?: () => string): Scene {
    const row = document.createElement('div');
    row.className = 'tour-proxy';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary';
    b.textContent = label;
    const why = document.createElement('small');
    row.append(b, why);
    extra.append(row);
    const sync = () => {
      const target = real();
      const ready = Boolean(target) && !target!.disabled && !target!.hidden;
      b.disabled = !ready;
      why.textContent = note ? note() : '';
      why.hidden = !why.textContent;
    };
    b.addEventListener('click', () => {
      const target = real();
      if (!target || target.disabled) return;
      target.click();
      sync();
    });
    sync();
    const off = this.ctx.onState(() => sync());
    return { cleanup: off };
  }

  private buildSteps(): Step[] {
    const ctx = this.ctx;
    const byId = (id: string) => () => {
      const el = document.getElementById(id);
      return el && !el.hidden && el.getClientRects().length ? el : null;
    };
    const firstOf =
      (...ids: string[]) =>
      () =>
        ids.map(id => byId(id)()).find(Boolean) ?? null;
    return [
      {
        target: byId('neural'),
        padding: 6,
        title: () => 'Meet the fly.',
        body: () =>
          'Every dot is a real neuron from a fruit fly, at its real position: <b>176,422 of them</b>, with every wire between them, simulated. The violet cloud is the <b>mushroom body</b>, the part that remembers smells. We are about to give it something to smell.',
        enter: () => ctx.focusMushroomBody(true),
        exit: () => ctx.focusMushroomBody(false),
      },
      {
        target: byId('diff-shell'),
        title: () => 'A fly can’t read. Jev is its nose.',
        body: s =>
          `Jev reads the change and answers <b>thirty tiny yes-or-no questions</b> about what changed${
            s?.features ? `, like “${noticed(s)[0]}”` : ''
          }. Not one of them asks whether the change is good. Jev is a nose, not a judge.`,
        scene: (s, host) => {
          host.append(sniffScene(noticed(s)));
        },
      },
      {
        target: firstOf('odor', 'input-story'),
        title: () => 'Answers become a smell.',
        body: s =>
          `Each answer is one scent; the words in the changed lines add a few more. Together they are a <b>53-scent smell</b>. In the fly, that smell wakes about <b>${(s?.brain?.activeKenyon ?? 200).toLocaleString()} of 4,064 memory cells</b>, the violet flicker in the brain. A different change wakes a different set.`,
        scene: (s, host) => {
          host.append(smellScene(s));
        },
        enter: () => {
          const strip = document.getElementById('odor-strip');
          strip?.classList.remove('rise');
          requestAnimationFrame(() => strip?.classList.add('rise'));
        },
        exit: () => document.getElementById('odor-strip')?.classList.remove('rise'),
      },
      {
        target: byId('reviewer-panel'),
        title: () => 'Two teams argue.',
        body: s => {
          const b = balance(s);
          const feed = s?.brain?.feedHz ?? 0;
          return `The memory cells shout to two teams of output cells: <b>back away</b> and <b>come closer</b>. Which team an output cell is on is decided by which dopamine neurons the wiring puts over it. The louder team wins, and if come closer wins hard enough the signal reaches the tongue: the proboscis comes out, and that is the fly’s approval. ${
            b.real
              ? `On screen right now: back away ${hz(b.avoid)}, come closer ${hz(b.approach)}, proboscis motor neurons ${hz(feed)}${feed >= 8 ? ', it reached for it' : ', it stayed still'}.`
              : 'A fly that has never learned anything comes out about even and keeps its tongue in, and that is a shrug.'
          } Watch the body: leaning in is come closer; backing off with the wings half up is back away.`;
        },
        scene: (s, host) => {
          const b = balance(s);
          host.append(tugScene(b.avoid, b.approach, b.share, !b.real).root);
        },
        enter: () => {
          let t = 0;
          const cycle = () => {
            ctx.leanFly({ approach: 1, avoid: 0 });
            t = window.setTimeout(() => {
              ctx.leanFly({ approach: 0, avoid: 1 });
              t = window.setTimeout(cycle, 1700);
            }, 1700);
          };
          cycle();
          this.cleanups.push(() => clearTimeout(t));
        },
        exit: () => ctx.leanFly(null),
      },
      {
        target: () => (ctx.state()?.verdict ? byId('verdict')() : ctx.askTheFly()),
        title: s => {
          const v = s?.verdict?.verdict;
          return !v
            ? 'Now ask it. I’ll wait.'
            : v === 'changes_requested'
              ? 'It backed away.'
              : v === 'no_objection'
                ? s?.verdict?.behavior === 'reached'
                  ? 'It reached for it.'
                  : 'It leaned in.'
                : 'It shrugged.';
        },
        body: s => {
          const v = s?.verdict?.verdict,
            b = balance(s),
            mem = s?.brain?.rememberedSynapses ?? 0;
          if (!v)
            return 'Press <b>Ask the fly</b> below. One live Jev call, then 176,422 neurons run for 450 ms of the fly’s time. When the vote lands, this card redraws around the real result.';
          const lessons = s!.memory.lessons,
            trained = lessons.filter(l => l.source === 'training').length;
          const memory = mem
            ? trained
              ? `This fly was taught ${trained} lessons by executed tests before you met it${lessons.length > trained ? `, and ${lessons.length - trained} more on this page` : ''}.`
              : `This fly remembers ${lessons.length} lesson${lessons.length === 1 ? '' : 's'}.`
            : 'This fly has never been taught anything.';
          const near = (s?.nearest ?? []).find(n => n.shared > 0);
          const closest = near
            ? ` The closest thing it was taught: <b>${near.title}</b>, ${near.lesson === 'punish' ? 'punished' : 'rewarded'}, ${Math.round(near.overlap * 100)}% of the same cells.`
            : '';
          const reached = s?.verdict?.behavior === 'reached';
          return v === 'changes_requested'
            ? `${memory} Back away won, ${hz(b.avoid)} to ${hz(b.approach)}, and its body stayed still. Something that smelled like this came with bitter before, so: <b>changes requested</b>.${closest}`
            : v === 'no_objection'
              ? reached
                ? `${memory} Its proboscis came out to the smell alone (${hz(s!.brain!.feedHz)} on the feeding motor neurons), which a naive fly never does: the body voted. Something that smelled like this came with sugar before, so: <b>no objection</b>. That is not a promise the code is right.${closest}`
                : `${memory} Come closer won, ${hz(b.approach)} to ${hz(b.avoid)}, though it did not reach for it. Something that smelled like this came with sugar before, so: <b>no objection</b>. That is not a promise the code is right.${closest}`
              : `${memory} The teams came out ${hz(b.avoid)} to ${hz(b.approach)} and its body stayed still: nothing in its memory smells much like this, so it <b>abstains</b>.${closest}`;
        },
        scene: (s, _host, extra) => {
          if (s?.verdict) return;
          return this.proxy(extra, 'Ask the fly', () => ctx.askTheFly(), ctx.readiness);
        },
        waitFor: next => Boolean(next.verdict && next.brain && next.phase === 'ready'),
      },
      {
        target: firstOf('lesson', 'verify', 'review'),
        title: () => 'Only a test can teach it.',
        body: s => {
          const l = s?.lesson;
          const t = l?.teaching;
          const learned = l
            ? l.lesson === 'punish'
              ? ` This run: the break was proven, bitter went on its tongue${t ? `, its PPL1 neurons fired at ${t.ppl1Hz.toFixed(0)} Hz,` : ''} and <b>${l.depressed.toLocaleString()} wires</b> were weakened where that dopamine landed${t ? ` (${t.byGroup.approach.toLocaleString()} to come closer, ${t.byGroup.avoid.toLocaleString()} to back away)` : ''}.`
              : ` This run: a designated harmless control the test could not break, sugar went on its tongue${t ? `, its PAM neurons fired at ${t.pamHz.toFixed(0)} Hz,` : ''} and <b>${l.depressed.toLocaleString()} wires</b> were weakened where that dopamine landed${t ? ` (${t.byGroup.avoid.toLocaleString()} to back away, ${t.byGroup.approach.toLocaleString()} to come closer)` : ''}.`
            : s?.verification && s.verification.status !== 'confirmed'
              ? ' This run: the test could not break it, and that is not proof of safety, so the fly learned nothing.'
              : '';
          return `A separate AI bets on one input and real code runs both versions. <b>Prove a break: bitter.</b> A bitter drop on its tongue while it smells the change. Its own punishment neurons (PPL1) fire, and the wiring decides where that dopamine lands: on the wires from these memory cells to come closer. <b>Known harmless and the test can’t break it: sugar.</b> Its reward neurons (PAM) fire and the wires to back away weaken. Anything else teaches nothing; “couldn’t break it” is not “safe”. The taste is about the smell, not a grade for the fly: if it already backed away, the same bitter just deepens that memory.${learned}`;
        },
        scene: (s, host, extra) => {
          const verify = ctx.control('verify');
          const proxied = verify && !s?.verification ? this.proxy(extra, 'Was the fly right?', () => verify) : null;
          let mode: 'punish' | 'reward' = s?.lesson?.lesson === 'reward' ? 'reward' : 'punish';
          const draw = () => host.replaceChildren(zapScene(mode));
          const seg = document.createElement('div');
          seg.className = 'tour-seg';
          seg.setAttribute('role', 'group');
          seg.setAttribute('aria-label', 'Which lesson to show');
          for (const [value, label] of [
            ['punish', 'Bitter: a break was proven'],
            ['reward', 'Sugar: known harmless'],
          ] as const) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.setAttribute('aria-pressed', String(value === mode));
            b.addEventListener('click', () => {
              mode = value;
              seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
              draw();
            });
            seg.append(b);
          }
          extra.append(seg);
          draw();
          return proxied ?? undefined;
        },
      },
      {
        target: firstOf('recall', 'verify', 'review'),
        title: () => 'Ask it again. Then make it forget.',
        body: () =>
          'Same change, same description, <b>same fly</b>. <b>Ask the fly again</b> and the only thing that can differ is what it learned; compare the measured share. <b>Forget everything</b> and the memory’s effect is gone. That is the whole proof that the memory did it, and not us.',
        scene: (s, host, extra) => {
          const b = balance(s);
          const before = b.real && !s?.lesson ? b.share : 0.53;
          const tug = tugScene(96, 88, before, true);
          host.append(tug.root);
          const seg = document.createElement('div');
          seg.className = 'tour-seg';
          for (const [label, share, note, a, c] of [
            ['Ask again', 0.74, 'after the bitter', 99, 35],
            ['Forget', 0.53, 'memory wiped', 96, 88],
          ] as const) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.addEventListener('click', () => {
              tug.shout(a, c);
              tug.moveTo(share, note);
            });
            seg.append(btn);
          }
          extra.append(seg);
          const cleanups = [
            ctx.control('recall') ? this.proxy(extra, 'Ask the fly again', () => ctx.control('recall')) : null,
            ctx.control('forget') && (s?.memory.lessons.length ?? 0) > 0
              ? this.proxy(extra, 'Forget everything', () => ctx.control('forget'))
              : null,
          ];
          return { cleanup: () => cleanups.forEach(c => c?.cleanup?.()) };
        },
      },
      {
        target: firstOf('attention', 'diff-shell'),
        title: s => (s?.attention ? 'Where it looked.' : 'A whole pull request: where would it look?'),
        body: s => {
          const a = s?.attention;
          if (!a)
            return 'A pull request is not one smell, it is a row of them. The fly reads the diff <b>hunk by hunk</b>; every hunk it smells makes that smell a little more familiar. Then it reads the diff again with those synapses frozen. Repeated smells have gone quiet. <b>Whatever still smells new is where it looks.</b> That is a real mushroom body circuit (the α\u20193 compartment), and it is the one thing here a list of yes/no answers cannot do on its own.';
          const looked = a.units[a.looked];
          const quiet = a.units.filter(u => u.reading.noveltyHz === 0).length;
          return `It read ${a.units.length} ${a.granularity}s, then read them again. ${quiet} had gone quiet. <b>${looked.filename}${looked.hunk === null ? '' : `, hunk ${looked.hunk + 1}`}</b> still evoked ${hz(looked.reading.noveltyHz)} of its first-exposure ${hz(looked.reading.naiveNoveltyHz)}, the most of any, so that is where it looked. The vote you saw is its vote on that ${a.granularity}. Novelty says <i>unlike the rest</i>, not <i>wrong</i>; the memory says what it thinks of it.`;
        },
        scene: (s, host) => {
          host.append(hunksScene(s));
        },
      },
      {
        target: byId('record'),
        title: () => 'Same smell, same answer.',
        body: () =>
          'Same smell, same fly, same memory: <b>the same answer every time, to the bit</b>. Jev’s sniff wobbles a little between calls, like anyone sniffing twice, so asking Jev again shifts the smell a hair. The fly’s vote is only as good as what taught it. So is anyone’s. And does the wiring matter, or is the brain decoration? Rewire which dopamine neuron reaches which output cell, degrees preserved, teach that fly the same 126 lessons, and it catches no regressions and reaches for everything. Thirty logistic weights classify about as well as this fly does; they have no wiring to shuffle.',
        scene: (_s, host) => {
          host.append(sameScene());
        },
      },
    ];
  }
}

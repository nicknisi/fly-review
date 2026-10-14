/**
 * The reviewer, seen from above, standing still. Every part that moves is wired to one of the measured populations,
 * using what those neurons do in a real fly:
 *
 *   A  MN9    feeding motor neurons      → the proboscis extends
 *   B  DNg62  grooming descending neuron → the front legs sweep over the head
 *   C  DNp01  giant fiber, escape        → wings raise and beat, body lifts, legs brace for takeoff
 *
 * Input stimulation reaches the sensory organs: eyes brighten, antennae twitch. The drawing is four stacked SVG layers
 * (shadow, legs, body, wings) in a tilted 3D stage, so it has depth and parallax without pretending to be a model.
 * Body parts carry data-poke names; clicking one stimulates that real sensory population in the simulation.
 */
import { POKE_PRESETS } from '../src/review-pokes.js';
import type { PokePreset } from '../src/review-pokes.js';

/**
 * Motor drives from the three readouts, sensory drive from the input, and the mushroom body's approach/avoid balance
 * (0..1 each). The optional three are read from the same recorded bin: how busy the whole network is (arousal), how many
 * Kenyon cells the smell woke (smell), and how hard the dopamine neurons are firing (dopamine).
 */
export type Drive = {
  feed: number;
  groom: number;
  escape: number;
  input: number;
  approach?: number;
  avoid?: number;
  arousal?: number;
  smell?: number;
  dopamine?: number;
};

const VIEW = 'viewBox="0 0 64 72" aria-hidden="true" focusable="false"';
const LAYERS = {
  shadow: `<svg class="layer shadow-layer" ${VIEW}><ellipse class="shadow" cx="32" cy="46" rx="12" ry="5.5" fill="rgba(0,0,0,.5)"/></svg>`,
  legs: `<svg class="layer legs-layer" ${VIEW}>
    <g class="legs" data-poke="feet" stroke="#3a2412" stroke-width="1.7" stroke-linecap="round" fill="none">
      <title>${POKE_PRESETS.feet.label}: ${POKE_PRESETS.feet.population}</title>
      <path class="leg l1" d="M27 26 L15 18 L9 20"/><path class="leg r1" d="M37 26 L49 18 L55 20"/>
      <path class="leg l2" d="M25 31 L11 32 L6 30"/><path class="leg r2" d="M39 31 L53 32 L58 30"/>
      <path class="leg l3" d="M26 36 L14 44 L9 43"/><path class="leg r3" d="M38 36 L50 44 L55 43"/>
      <path class="hit" d="M27 26 L15 18 L9 20 M37 26 L49 18 L55 20 M25 31 L11 32 L6 30 M39 31 L53 32 L58 30 M26 36 L14 44 L9 43 M38 36 L50 44 L55 43" stroke="transparent" stroke-width="7"/>
    </g></svg>`,
  body: `<svg class="layer body-layer" ${VIEW}>
    <defs>
      <radialGradient id="fly-abdomen" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#d9a45a"/><stop offset=".7" stop-color="#a8712f"/><stop offset="1" stop-color="#6e4519"/></radialGradient>
      <radialGradient id="fly-thorax" cx="42%" cy="28%" r="75%"><stop offset="0" stop-color="#eebb6c"/><stop offset=".65" stop-color="#c58d42"/><stop offset="1" stop-color="#7c5220"/></radialGradient>
      <radialGradient id="fly-head" cx="45%" cy="30%" r="70%"><stop offset="0" stop-color="#e6b264"/><stop offset=".7" stop-color="#bf853c"/><stop offset="1" stop-color="#7a4f1e"/></radialGradient>
      <radialGradient id="fly-eye" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ff7a5c"/><stop offset=".55" stop-color="#c8362b"/><stop offset="1" stop-color="#6e140c"/></radialGradient>
    </defs>
    <g class="body">
      <g class="abdomen" data-poke="abdomen"><title>${POKE_PRESETS.abdomen.label}: ${POKE_PRESETS.abdomen.population}</title>
        <ellipse cx="32" cy="43" rx="7.8" ry="11.8" fill="url(#fly-abdomen)"/>
        <path d="M25.2 40 Q32 43 38.8 40 M24.8 45 Q32 48 39.2 45 M25.6 50 Q32 53 38.4 50" stroke="#3f2609" stroke-width="2.2" fill="none" stroke-linecap="round" opacity=".85"/>
      </g>
      <g class="thorax" data-poke="brush"><title>${POKE_PRESETS.brush.label}: ${POKE_PRESETS.brush.population}</title>
        <ellipse cx="32" cy="28" rx="8.8" ry="9.6" fill="url(#fly-thorax)"/>
        <g class="bristles" stroke="#3a2412" stroke-width=".7" stroke-linecap="round"><path d="M26 22 l-1.6 -2 M29 20 l-.8 -2.2 M35 20 l.8 -2.2 M38 22 l1.6 -2 M25 30 l-2 .4 M39 30 l2 .4"/></g>
      </g>
      <g class="proboscis" data-poke="sugar"><title>${POKE_PRESETS.sugar.label}: ${POKE_PRESETS.sugar.population}</title>
        <rect x="30.1" y="20" width="3.8" height="13" rx="1.7" fill="#8a5a28"/><ellipse cx="32" cy="33" rx="3.6" ry="1.9" fill="#5e3814"/>
        <path class="hit" d="M28 20 h8 v15 h-8 z" fill="transparent"/>
      </g>
      <circle class="head" cx="32" cy="15.5" r="7" fill="url(#fly-head)"/>
      <g class="eyes" data-poke="eyes"><title>${POKE_PRESETS.eyes.label}: ${POKE_PRESETS.eyes.population}</title>
        <ellipse class="eye" cx="26.4" cy="14.6" rx="3.8" ry="4.6" fill="url(#fly-eye)"/><ellipse class="eye" cx="37.6" cy="14.6" rx="3.8" ry="4.6" fill="url(#fly-eye)"/>
        <circle cx="25.4" cy="12.8" r="1.1" fill="rgba(255,255,255,.8)"/><circle cx="36.6" cy="12.8" r="1.1" fill="rgba(255,255,255,.8)"/>
      </g>
      <g class="antennae" data-poke="antennae" stroke="#3a2412" stroke-width="1.4" stroke-linecap="round" fill="none"><title>${POKE_PRESETS.antennae.label}: ${POKE_PRESETS.antennae.population}</title>
        <path d="M29.5 10 L26.5 4.5 M26.5 4.5 l-1.4 -.6"/><path d="M34.5 10 L37.5 4.5 M37.5 4.5 l1.4 -.6"/>
        <path class="hit" d="M24 2 h16 v9 h-16 z" fill="transparent" stroke="none"/>
      </g>
    </g></svg>`,
  wings: `<svg class="layer wings-layer" ${VIEW}>
    <defs><linearGradient id="fly-wing" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(230,240,255,.78)"/><stop offset="1" stop-color="rgba(170,190,235,.42)"/></linearGradient></defs>
    <g class="wings" fill="url(#fly-wing)" stroke="rgba(120,140,190,.6)" stroke-width=".9">
      <ellipse class="wing left" cx="18" cy="38" rx="7.5" ry="17"/>
      <ellipse class="wing right" cx="46" cy="38" rx="7.5" ry="17"/>
      <path class="vein left" d="M18 22 L17 54 M18 24 L12 50 M18 24 L24 50" stroke="rgba(120,140,190,.45)" stroke-width=".6" fill="none"/>
      <path class="vein right" d="M46 22 L47 54 M46 24 L52 50 M46 24 L40 50" stroke="rgba(120,140,190,.45)" stroke-width=".6" fill="none"/>
    </g></svg>`,
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export class FlyAvatar {
  private last = '';
  private stage: HTMLDivElement;
  /** Fired with the preset name when a body part is clicked. */
  onPoke: (preset: PokePreset) => void = () => {};

  constructor(private host: HTMLElement) {
    host.innerHTML = '';
    this.stage = document.createElement('div');
    this.stage.className = 'fly-3d';
    this.stage.innerHTML = LAYERS.shadow + LAYERS.legs + LAYERS.body + LAYERS.wings;
    host.append(this.stage);
    this.drive({ feed: 0, groom: 0, escape: 0, input: 0 });
    // Parallax: the stage tilts toward the pointer so the stacked layers read as depth. Not under reduced motion.
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    host.addEventListener('pointermove', event => {
      if (reduce.matches) return;
      const r = host.getBoundingClientRect();
      const x = (event.clientX - r.left) / r.width - 0.5,
        y = (event.clientY - r.top) / r.height - 0.5;
      host.style.setProperty('--tilt-y', `${(x * 26).toFixed(1)}deg`);
      host.style.setProperty('--tilt-x', `${(34 - y * 16).toFixed(1)}deg`);
    });
    host.addEventListener('pointerleave', () => {
      host.style.removeProperty('--tilt-y');
      host.style.removeProperty('--tilt-x');
    });
    host.addEventListener('click', event => {
      const part = (event.target as Element).closest<SVGElement>('[data-poke]');
      const preset = part?.dataset.poke as PokePreset | undefined;
      if (preset && preset in POKE_PRESETS && !host.classList.contains('locked')) this.onPoke(preset);
    });
  }

  /** Each value is 0..1: the measured rate over that population's normalizer, or the input rate over 200 Hz. */
  drive(d: Drive) {
    const feed = clamp(d.feed),
      groom = clamp(d.groom),
      escape = clamp(d.escape),
      input = clamp(d.input);
    const key = [feed, groom, escape, input].map(n => n.toFixed(2)).join('/');
    if (key === this.last) return;
    this.last = key;
    const s = this.host.style;
    s.setProperty('--feed', String(feed));
    s.setProperty('--groom', String(groom));
    s.setProperty('--escape', String(escape));
    s.setProperty('--input', String(input));
    s.setProperty('--approach', String(clamp(d.approach ?? 0)));
    s.setProperty('--avoid', String(clamp(d.avoid ?? 0)));
    this.host.classList.toggle('feeding', feed > 0.02);
    this.host.classList.toggle('grooming', groom > 0.02);
    this.host.classList.toggle('escaping', escape > 0.05);
    this.host.classList.toggle('stimulated', input > 0.02);
  }
  /** Highlight the organ being stimulated (or none). */
  poked(preset: PokePreset | null) {
    if (preset) this.host.dataset.poked = POKE_PRESETS[preset].part;
    else delete this.host.dataset.poked;
  }
  /** Pokes are real simulations; lock the drawing while one is running or the server is away. */
  lock(locked: boolean) {
    this.host.classList.toggle('locked', locked);
  }
}

/** One line of plain language for what the measured outputs mean to the animal. Our reading of motor outputs, nothing more. */
export function behavior(
  feed: number,
  groom: number,
  escape: number,
  bitter = false,
): { a: string; b: string; c: string; summary: string } {
  const a =
    feed <= 0
      ? bitter
        ? 'proboscis held back: bitter'
        : 'proboscis retracted'
      : feed < 8 / 90
        ? 'proboscis twitching'
        : 'proboscis extended, reaching';
  const b = groom <= 0 ? 'legs still' : groom < 0.4 ? 'a few grooming strokes' : 'grooming its head';
  const c = escape <= 0 ? 'wings folded' : escape < 0.4 ? 'wings stirring' : 'wings up, braced to jump';
  const summary =
    feed <= 0 && groom <= 0 && escape <= 0
      ? bitter
        ? 'Refusing. Bitter on the labellum; the proboscis stays in and nothing downstream fires.'
        : 'Resting. Nothing downstream is firing.'
      : feed > 0 && escape > 0
        ? 'Hungry and alarmed at the same time: reaching for sugar while braced to flee.'
        : escape > 0 && groom > 0
          ? 'Grooming while braced to flee.'
          : escape > 0
            ? 'Pure alarm. The escape circuit is firing and nothing else is.'
            : feed > 0 && groom > 0
              ? 'Feeding and grooming at once.'
              : feed > 0
                ? 'Hungry. The feeding circuit is firing and nothing else is.'
                : 'Grooming. The grooming circuit is firing and nothing else is.';
  return { a, b, c, summary };
}

/** Plain language for the mushroom body's balance in this bin. */
export function mushroomReading(avoidHz: number, approachHz: number): string {
  const total = avoidHz + approachHz;
  if (total < 20) return 'Mushroom body quiet.';
  const share = avoidHz / total;
  return share >= 0.68
    ? 'Turning away from this smell: avoidance MBONs are winning.'
    : share <= 0.45
      ? 'Drawn to this smell: approach MBONs are winning.'
      : 'Smelling it, undecided: avoidance and approach MBONs are even.';
}

/** Review comments in the reviewer's voice, chosen by seed so the same fly says the same thing. */
export const QUIPS = {
  changes_requested: [
    'Explanation unavailable. Reviewer is a fruit fly.',
    'Have you considered rotting fruit instead?',
    'I have 176,422 neurons and every one of them objects.',
    'This smells wrong. I would know.',
    'Nit: everything.',
    'Requesting changes. Also requesting a banana.',
  ],
  no_objection: [
    'Please don’t put “a fly approved it” in the incident report.',
    'LGTM. Looks Good To Me, a fly.',
    'Ship it. What could possibly go wrong.',
    'No notes. I have no notes. I am a fly.',
    'Approved with the confidence of an insect.',
    'Merge it before the fruit turns.',
  ],
  abstain: [
    'Not enough downstream activity to issue a verdict.',
    'I need to see more sugar before I can comment.',
    'Abstaining. Please do not wake me for the retro.',
  ],
  /** The body voted: the proboscis came out to the smell alone. */
  reached: [
    'Proboscis out. That is the whole review.',
    'I licked it. Please don’t put that in the incident report.',
    'Tastes like a change that got me sugar before.',
    'My tongue approves. My tongue has been wrong before.',
    'Reaching for it with the confidence of an insect.',
    'Smells like sugar. Merge it before the fruit turns.',
  ],
} as const;
export const quip = (list: readonly string[], seed: number) => list[Math.abs(seed) % list.length];

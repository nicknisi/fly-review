/**
 * A procedural, lit, three-dimensional Drosophila. No mesh file: the body is built from ellipsoids and tapered tubes
 * with the proportions of the animal, shaded with a directional light, compound-eye facets, cuticle banding, and
 * translucent veined wings. Every moving part is wired to one of the measured populations:
 *
 *   A  MN9    feeding motor neurons      → the proboscis extends and pumps
 *   B  DNg62  grooming descending neuron → the front legs sweep over the head
 *   C  DNp01  giant fiber, escape        → wings raise and beat, body lifts, legs brace for takeoff
 *
 * Input stimulation brightens the eyes and twitches the antennae. Drives are smoothed with a short time constant so
 * the animal reacts within a frame or two of a new bin, then settles. Body parts are pickable; a click on one reports
 * the sensory population that lives there.
 */
import { POKE_PRESETS } from '../src/review-pokes.js';
import type { PokePreset } from '../src/review-pokes.js';
import type { Drive } from './fly.js';

type Mesh = { positions: Float32Array; normals: Float32Array; indices: Uint16Array; count: number };
type Geometry = { positions: number[]; normals: number[]; indices: number[] };
type Mat4 = Float32Array;

// ---------- small matrix library (column-major, like WebGL) ----------
const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
const translation = (x: number, y: number, z: number): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scaling = (x: number, y: number, z: number): Mat4 =>
  new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
function rotationX(a: number): Mat4 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function rotationY(a: number): Mat4 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function rotationZ(a: number): Mat4 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
const chain = (...ms: Mat4[]) => ms.reduce((acc, m) => multiply(acc, m), identity());
function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2),
    nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z)),
    y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v: number[]) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
/** Inverse-transpose of the upper 3×3, so normals survive non-uniform scaling. */
function normalMatrix(m: Mat4): Float32Array {
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[4],
    e = m[5],
    f = m[6],
    g = m[8],
    h = m[9],
    i = m[10];
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-6;
  return new Float32Array([
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ]);
}

// ---------- geometry ----------
/** Ellipsoid with z as the long axis; profile(t) scales the cross-section along z (t: 0 back, 1 front). */
function ellipsoid(
  rx: number,
  ry: number,
  rz: number,
  seg = 26,
  rings = 18,
  profile: (t: number) => number = () => 1,
): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  for (let r = 0; r <= rings; r++) {
    const v = r / rings,
      phi = v * Math.PI,
      cz = Math.cos(phi),
      sz = Math.sin(phi);
    const k = profile(1 - v);
    for (let s = 0; s <= seg; s++) {
      const u = (s / seg) * Math.PI * 2,
        x = Math.cos(u) * sz * rx * k,
        y = Math.sin(u) * sz * ry * k,
        z = cz * rz;
      g.positions.push(x, y, z);
      const n = normalize([x / (rx * rx * k * k), y / (ry * ry * k * k), z / (rz * rz)]);
      g.normals.push(n[0], n[1], n[2]);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s,
        b = a + seg + 1;
      g.indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  return g;
}
/** Tapered tube along +z from 0 to length. */
function tube(r0: number, r1: number, length: number, seg = 10): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  const slope = (r0 - r1) / length;
  for (let k = 0; k <= 1; k++) {
    const r = k ? r1 : r0,
      z = k ? length : 0;
    for (let s = 0; s <= seg; s++) {
      const u = (s / seg) * Math.PI * 2,
        x = Math.cos(u),
        y = Math.sin(u);
      g.positions.push(x * r, y * r, z);
      const n = normalize([x, y, slope]);
      g.normals.push(n[0], n[1], n[2]);
    }
  }
  for (let s = 0; s < seg; s++) g.indices.push(s, s + seg + 1, s + 1, s + seg + 1, s + seg + 2, s + 1);
  return g;
}
/** A wing in its own plane (y up is the normal), root at the origin, span along +x. */
function wing(span: number, chord: number, mirror: boolean): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  const n = 28,
    sx = mirror ? -1 : 1;
  g.positions.push(0, 0, 0);
  g.normals.push(0, 1, 0);
  const outline: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      w = chord * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.62) * (1 - 0.18 * t);
    outline.push([sx * span * t, 0, -w * 0.62 - 0.02 * t]);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n,
      w = chord * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.62) * (1 - 0.18 * t);
    outline.push([sx * span * t, 0, w * 0.38 + 0.02 * t]);
  }
  for (const p of outline) {
    g.positions.push(p[0], p[1], p[2]);
    g.normals.push(0, 1, 0);
  }
  for (let i = 1; i < outline.length; i++) g.indices.push(0, i, i + 1 > outline.length ? 1 : i + 1);
  return g;
}
function mirrorX(g: Geometry): Geometry {
  const positions = g.positions.map((v, i) => (i % 3 === 0 ? -v : v)),
    normals = g.normals.map((v, i) => (i % 3 === 0 ? -v : v));
  const indices: number[] = [];
  for (let i = 0; i < g.indices.length; i += 3) indices.push(g.indices[i], g.indices[i + 2], g.indices[i + 1]);
  return { positions, normals, indices };
}

const VERTEX = `
attribute vec3 position; attribute vec3 normal;
uniform mat4 model, view, projection; uniform mat3 normalMat;
varying vec3 vNormal, vWorld, vLocal;
void main(){ vLocal=position; vec4 w=model*vec4(position,1.0); vWorld=w.xyz; vNormal=normalize(normalMat*normal); gl_Position=projection*view*w; }`;
const FRAGMENT = `
precision mediump float;
uniform vec3 color, glow, eye; uniform float alpha, shininess; uniform int pattern; uniform bool picking; uniform vec3 pickColor;
varying vec3 vNormal, vWorld, vLocal;
float hexcell(vec2 p){ vec2 q=vec2(p.x*1.1547, p.y+p.x*0.5773); vec2 f=fract(q)-0.5; return length(f); }
void main(){
  if(picking){ gl_FragColor=vec4(pickColor,1.0); return; }
  vec3 n=normalize(vNormal); vec3 v=normalize(eye-vWorld); if(dot(n,v)<0.0 && pattern==4) n=-n;
  vec3 base=color; float shade=1.0; float spec=0.0;
  if(pattern==1){ float s=abs(sin(vLocal.x*11.0)); shade=mix(0.62,1.0,smoothstep(0.55,0.9,s)); shade*=mix(0.85,1.0,smoothstep(-0.5,0.3,vLocal.y)); }
  if(pattern==2){ float band=fract(vLocal.z*3.1+0.2); shade=mix(0.42,1.0,smoothstep(0.42,0.58,band)); shade*=mix(0.55,1.0,smoothstep(-1.0,0.2,vLocal.z)); shade*=mix(0.8,1.0,smoothstep(-0.4,0.3,vLocal.y)); }
  if(pattern==3){ float d=hexcell(vLocal.xy*34.0+vLocal.z*9.0); shade=mix(0.55,1.15,smoothstep(0.42,0.12,d)); n=normalize(n+vec3(0.0,0.0,0.0)); }
  vec3 L=normalize(vec3(0.35,0.85,0.5)); vec3 L2=normalize(vec3(-0.6,0.2,-0.4));
  float diff=max(dot(n,L),0.0)*0.78+max(dot(n,L2),0.0)*0.22;
  float amb=0.30+0.12*(n.y*0.5+0.5);
  vec3 h=normalize(L+v); spec=pow(max(dot(n,h),0.0),shininess)*(pattern==3?1.4:0.35);
  vec3 c=base*shade*(amb+diff)+vec3(spec)+glow;
  float a=alpha;
  if(pattern==4){ float fr=pow(1.0-abs(dot(n,v)),2.0); c=mix(base,vec3(1.0),fr*0.6)*(0.65+0.45*diff)+vec3(spec*0.5)+glow; a=alpha+fr*0.35; }
  gl_FragColor=vec4(c,a);
}`;

type Part = {
  mesh: Mesh;
  model: Mat4;
  color: [number, number, number];
  alpha?: number;
  shininess?: number;
  pattern?: number;
  pick?: PokePreset;
};
const PICK_IDS: PokePreset[] = ['sugar', 'feet', 'antennae', 'eyes', 'brush', 'abdomen'];
const deg = (d: number) => (d * Math.PI) / 180;

export class FlyModel {
  onPoke: (preset: PokePreset) => void = () => {};
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private attrs: Record<string, number> = {};
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private meshes: Record<string, Mesh> = {};
  private target: Required<Drive> = { feed: 0, groom: 0, escape: 0, input: 0, approach: 0, avoid: 0 };
  private current: Required<Drive> = { feed: 0, groom: 0, escape: 0, input: 0, approach: 0, avoid: 0 };
  private glowPart: string | null = null;
  private locked = false;
  private yaw = deg(-30);
  private pitch = deg(46);
  private pointer: { x: number; y: number } | null = null;
  private lastTime = 0;
  private beat = 0;
  private groomPhase = 0;

  constructor(private host: HTMLElement) {
    host.innerHTML = '';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fly-model-canvas';
    this.canvas.setAttribute('aria-label', 'The fly. Click a body part to stimulate that sensory population.');
    host.append(this.canvas);
    const gl = this.canvas.getContext('webgl', {
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
    this.program = program;
    for (const a of ['position', 'normal']) this.attrs[a] = gl.getAttribLocation(program, a);
    for (const u of [
      'model',
      'view',
      'projection',
      'normalMat',
      'color',
      'glow',
      'eye',
      'alpha',
      'shininess',
      'pattern',
      'picking',
      'pickColor',
    ])
      this.uniforms[u] = gl.getUniformLocation(program, u);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.buildMeshes();
    // Parallax follows the pointer, except under reduced motion, where the camera holds still.
    host.addEventListener('pointermove', e => {
      if (this.reduceMotion.matches) return;
      const r = host.getBoundingClientRect();
      this.pointer = { x: (e.clientX - r.left) / r.width - 0.5, y: (e.clientY - r.top) / r.height - 0.5 };
    });
    host.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.wake();
    });
    this.canvas.addEventListener('click', e => {
      if (this.locked) return;
      const r = this.canvas.getBoundingClientRect();
      const preset = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (preset) this.onPoke(preset);
    });
    this.canvas.addEventListener('pointermove', e => {
      const r = this.canvas.getBoundingClientRect();
      const preset = this.pick(e.clientX - r.left, e.clientY - r.top);
      this.canvas.style.cursor = preset && !this.locked ? 'pointer' : 'default';
      this.canvas.title = preset ? `${POKE_PRESETS[preset].label}: ${POKE_PRESETS[preset].population}` : '';
    });
    // Redraw on size and preference changes; under reduced motion these are the only things besides new data that redraw.
    new ResizeObserver(() => this.wake()).observe(host);
    this.reduceMotion.addEventListener('change', () => {
      this.pointer = null;
      this.wake();
    });
    this.wake();
  }

  private upload(g: Geometry): Mesh {
    return {
      positions: new Float32Array(g.positions),
      normals: new Float32Array(g.normals),
      indices: new Uint16Array(g.indices),
      count: g.indices.length,
    };
  }
  private buildMeshes() {
    const m = this.meshes;
    m.thorax = this.upload(ellipsoid(0.56, 0.52, 0.62, 30, 20, t => 1 - 0.08 * Math.pow(1 - t, 2)));
    m.head = this.upload(ellipsoid(0.36, 0.34, 0.3, 26, 18));
    m.eye = this.upload(ellipsoid(0.16, 0.23, 0.2, 22, 16));
    m.ocellus = this.upload(ellipsoid(0.028, 0.028, 0.028, 8, 6));
    m.abdomen = this.upload(
      ellipsoid(0.52, 0.47, 0.92, 30, 22, t => 0.52 + 0.48 * Math.pow(Math.min(1, t * 1.15), 0.7)),
    );
    m.rostrum = this.upload(tube(0.1, 0.085, 1, 12));
    m.haustellum = this.upload(tube(0.075, 0.06, 1, 12));
    m.labellum = this.upload(ellipsoid(0.13, 0.1, 0.075, 16, 10));
    m.antenna = this.upload(tube(0.04, 0.032, 0.13, 8));
    m.arista = this.upload(tube(0.009, 0.004, 0.32, 6));
    m.femur = this.upload(tube(0.046, 0.036, 1, 9));
    m.tibia = this.upload(tube(0.032, 0.022, 1, 9));
    m.tarsus = this.upload(tube(0.02, 0.011, 1, 8));
    m.haltere = this.upload(tube(0.016, 0.012, 0.26, 6));
    m.knob = this.upload(ellipsoid(0.05, 0.045, 0.05, 10, 8));
    m.wingR = this.upload(wing(2.05, 0.72, false));
    m.wingL = this.upload(wing(2.05, 0.72, true));
    m.vein = this.upload(tube(0.011, 0.006, 1, 5));
    m.shadow = this.upload(ellipsoid(0.75, 0.01, 1.35, 24, 4));
    m.bristle = this.upload(tube(0.008, 0.002, 0.16, 4));
  }

  drive(d: Drive) {
    this.wake();
    this.target = {
      feed: clamp(d.feed),
      groom: clamp(d.groom),
      escape: clamp(d.escape),
      input: clamp(d.input),
      approach: clamp(d.approach ?? 0),
      avoid: clamp(d.avoid ?? 0),
    };
  }
  poked(preset: PokePreset | null) {
    this.wake();
    this.glowPart = preset ? POKE_PRESETS[preset].part : null;
  }
  lock(locked: boolean) {
    this.locked = locked;
  }

  private leg(
    side: 1 | -1,
    coxa: number[],
    yaw: number,
    femurPitch: number,
    tibiaBend: number,
    tarsusBend: number,
    lengths = [0.5, 0.56, 0.58],
  ): Part[] {
    const base = chain(translation(coxa[0] * side, coxa[1], coxa[2]), rotationY(side * yaw), rotationX(femurPitch));
    const femur = chain(base, scaling(1, 1, lengths[0]));
    const knee = chain(base, translation(0, 0, lengths[0]), rotationX(tibiaBend));
    const tibia = chain(knee, scaling(1, 1, lengths[1]));
    const ankle = chain(knee, translation(0, 0, lengths[1]), rotationX(tarsusBend));
    const tarsus = chain(ankle, scaling(1, 1, lengths[2]));
    const leg: [number, number, number] = [0.34, 0.23, 0.12];
    return [
      { mesh: this.meshes.femur, model: femur, color: leg, shininess: 22, pick: 'feet' },
      { mesh: this.meshes.tibia, model: tibia, color: leg, shininess: 22, pick: 'feet' },
      { mesh: this.meshes.tarsus, model: tarsus, color: [0.24, 0.16, 0.08], shininess: 18, pick: 'feet' },
    ];
  }

  /** Every part's placement for the current smoothed drives and time. */
  private scene(t: number): Part[] {
    const { feed, groom, escape, input, approach, avoid } = this.current;
    // Mushroom body: approach leans the animal into the smell. Avoidance is a decision, not a flinch: the fly steps back and
    // turns its body away, wings staying down. Escape (DNp01) is the flinch, and only escape raises the wings.
    const lean = approach * 0.55 - avoid * 0.5;
    const turn = deg(avoid * 34);
    const m = this.meshes,
      parts: Part[] = [];
    const lift = escape * 0.22,
      breathe = 1 + 0.012 * Math.sin(t * 2 * Math.PI * 0.9);
    const body = chain(translation(0, lift, lean * 0.12), rotationY(turn), rotationX(deg(lean * 9)));
    const cuticle: [number, number, number] = [0.8, 0.6, 0.34];
    parts.push({
      mesh: m.shadow,
      model: chain(translation(0, 0.005, -0.15), scaling(1 + escape * 0.35, 1, 1 + escape * 0.25)),
      color: [0, 0, 0],
      alpha: 0.5 - escape * 0.32,
      shininess: 1,
    });
    parts.push({
      mesh: m.thorax,
      model: chain(body, translation(0, 0.64, 0.15), rotationX(deg(8))),
      color: cuticle,
      shininess: 30,
      pattern: 1,
      pick: 'brush',
    });
    parts.push({
      mesh: m.abdomen,
      model: chain(
        body,
        translation(0, 0.52 - 0.04 * escape, -0.9),
        rotationX(deg(-6) - escape * deg(10)),
        scaling(breathe, breathe, 1),
      ),
      color: [0.74, 0.53, 0.28],
      shininess: 24,
      pattern: 2,
      pick: 'abdomen',
    });
    const head = chain(
      body,
      translation(0, 0.7, 0.93),
      // Looking away completes the turn; the head swings a little further than the body.
      rotationY(deg(avoid * 12)),
      rotationX(deg(-10) + approach * deg(14) + Math.sin(t * 7) * input * deg(2)),
    );
    parts.push({ mesh: m.head, model: head, color: [0.79, 0.59, 0.33], shininess: 28, pick: 'brush' });
    for (const side of [1, -1] as const) {
      parts.push({
        mesh: m.eye,
        model: chain(head, translation(side * 0.3, 0.03, 0.04), rotationY(side * deg(28)), rotationZ(side * deg(-8))),
        color: [0.72 + input * 0.25, 0.17 + input * 0.08, 0.1],
        shininess: 60,
        pattern: 3,
        pick: 'eyes',
      });
      // Antenna: a short segment pointing forward-down, an arista sweeping up; twitch with input.
      const ant = chain(
        head,
        translation(side * 0.11, 0.1, 0.32),
        rotationX(deg(112) + Math.sin(t * 14 + side) * input * deg(9)),
        rotationZ(side * deg(-12)),
      );
      parts.push({ mesh: m.antenna, model: ant, color: [0.55, 0.38, 0.2], shininess: 18, pick: 'antennae' });
      parts.push({
        mesh: m.arista,
        model: chain(ant, translation(0, 0, 0.12), rotationX(deg(-75))),
        color: [0.3, 0.2, 0.1],
        shininess: 10,
        pick: 'antennae',
      });
      parts.push({
        mesh: m.ocellus,
        model: chain(head, translation(side * 0.06, 0.33, -0.08)),
        color: [0.6, 0.15, 0.1],
        shininess: 80,
      });
      // Haltere: tiny club behind the wing.
      const hal = chain(body, translation(side * 0.5, 0.62, -0.35), rotationY(side * deg(40)), rotationX(deg(95)));
      parts.push({ mesh: m.haltere, model: hal, color: [0.6, 0.45, 0.3], shininess: 14, pick: 'brush' });
      parts.push({
        mesh: m.knob,
        model: chain(hal, translation(0, 0, 0.27)),
        color: [0.62, 0.47, 0.3],
        shininess: 14,
        pick: 'brush',
      });
      // Wings: at rest folded back over the abdomen; escape raises and beats them.
      const flare = escape;
      const beat = Math.sin(this.beat) * escape;
      const yaw = deg(78) - flare * deg(42) + beat * deg(16);
      const roll = flare * deg(58) + beat * deg(22) + deg(2);
      const hinge = chain(
        body,
        translation(side * 0.34, 0.94, 0.22),
        rotationZ(side * roll),
        rotationY(side === 1 ? yaw : -yaw),
        rotationX(deg(-3)),
      );
      parts.push({
        mesh: side === 1 ? m.wingR : m.wingL,
        model: hinge,
        color: [0.84, 0.89, 1.0],
        alpha: 0.26,
        shininess: 90,
        pattern: 4,
        pick: 'brush',
      });
      for (const [along, offset] of [
        [1.95, -0.1],
        [1.8, -0.28],
        [1.6, 0.12],
        [1.3, -0.02],
      ] as const)
        parts.push({
          mesh: m.vein,
          model: chain(
            hinge,
            translation(0, 0.004, offset * 0.6),
            rotationY(side === 1 ? deg(90) : deg(-90)),
            rotationX(0),
            scaling(1, 1, along),
          ),
          color: [0.35, 0.3, 0.32],
          alpha: 0.7,
          shininess: 8,
        });
      // Legs. Front legs groom when B fires: they lift and sweep over the head, alternating.
      const gp = this.groomPhase + (side === 1 ? 0 : Math.PI);
      const sweep = groom * (0.5 + 0.5 * Math.sin(gp));
      const brace = Math.max(escape, avoid * 0.25);
      parts.push(
        ...this.leg(
          side,
          [0.3, 0.42, 0.52],
          deg(48) - sweep * deg(46),
          deg(-28) - sweep * deg(58) - brace * deg(10),
          deg(98) + sweep * deg(30) - brace * deg(18),
          deg(48) - sweep * deg(20),
        ),
      );
      parts.push(
        ...this.leg(side, [0.44, 0.36, 0.14], deg(96), deg(-22) - brace * deg(14), deg(96) - brace * deg(22), deg(46)),
      );
      parts.push(
        ...this.leg(
          side,
          [0.36, 0.38, -0.26],
          deg(142),
          deg(-18) - brace * deg(12),
          deg(92) - brace * deg(20),
          deg(50),
        ),
      );
    }
    // Proboscis: rostrum, haustellum, labellum; extension follows the feeding rate, with a pump while eating.
    const pump = feed > 0.02 ? 0.06 * Math.sin(t * 2 * Math.PI * 1.6) * feed : 0;
    const ext = 0.16 + (0.62 + pump) * feed;
    const pro = chain(head, translation(0, -0.3, 0.06), rotationX(deg(92) - feed * deg(14)));
    parts.push({
      mesh: m.rostrum,
      model: chain(pro, scaling(1, 1, ext * 0.42)),
      color: [0.52, 0.36, 0.2],
      shininess: 20,
      pick: 'sugar',
    });
    const haust = chain(pro, translation(0, 0, ext * 0.42), rotationX(feed * deg(12)));
    parts.push({
      mesh: m.haustellum,
      model: chain(haust, scaling(1, 1, ext * 0.58)),
      color: [0.46, 0.31, 0.17],
      shininess: 20,
      pick: 'sugar',
    });
    parts.push({
      mesh: m.labellum,
      model: chain(haust, translation(0, 0, ext * 0.58 + 0.03), rotationX(deg(90)), scaling(1 + feed * 0.25, 1, 1)),
      color: [0.36, 0.23, 0.13],
      shininess: 30,
      pick: 'sugar',
    });
    return parts;
  }

  private draw(parts: Part[], picking: boolean) {
    const gl = this.gl,
      dpr = Math.min(devicePixelRatio || 1, 2);
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width * dpr)),
      height = Math.max(1, Math.round(bounds.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    const yaw = this.yaw + (this.pointer?.x ?? 0) * deg(50),
      pitch = this.pitch - (this.pointer?.y ?? 0) * deg(26);
    const dist = 5.7,
      target = [0, 0.55, -0.1];
    const eye = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    gl.uniformMatrix4fv(this.uniforms.view, false, lookAt(eye, target, [0, 1, 0]));
    gl.uniformMatrix4fv(this.uniforms.projection, false, perspective(deg(30), width / height, 0.5, 30));
    gl.uniform3f(this.uniforms.eye, eye[0], eye[1], eye[2]);
    gl.uniform1i(this.uniforms.picking, picking ? 1 : 0);
    // Opaque first, translucent wings last so the body shows through them.
    const ordered = [...parts.filter(p => (p.alpha ?? 1) >= 1), ...parts.filter(p => (p.alpha ?? 1) < 1)];
    for (const part of ordered) {
      if (picking && !part.pick) continue;
      const mesh = part.mesh;
      gl.uniformMatrix4fv(this.uniforms.model, false, part.model);
      gl.uniformMatrix3fv(this.uniforms.normalMat, false, normalMatrix(part.model));
      gl.uniform3f(this.uniforms.color, part.color[0], part.color[1], part.color[2]);
      gl.uniform1f(this.uniforms.alpha, part.alpha ?? 1);
      gl.uniform1f(this.uniforms.shininess, part.shininess ?? 20);
      gl.uniform1i(this.uniforms.pattern, part.pattern ?? 0);
      const glowing = this.glowPart && part.pick && POKE_PRESETS[part.pick].part === this.glowPart;
      gl.uniform3f(this.uniforms.glow, glowing ? 0.35 : 0, glowing ? 0.28 : 0, glowing ? 0.05 : 0);
      const id = part.pick ? PICK_IDS.indexOf(part.pick) + 1 : 0;
      gl.uniform3f(this.uniforms.pickColor, id / 255, 0, 0);
      gl.depthMask((part.alpha ?? 1) >= 1);
      if (part.pattern === 4) gl.disable(gl.CULL_FACE);
      else {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      }
      this.bind(mesh);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.depthMask(true);
  }
  private buffers = new WeakMap<Mesh, { p: WebGLBuffer; n: WebGLBuffer; i: WebGLBuffer }>();
  private bind(mesh: Mesh) {
    const gl = this.gl;
    let b = this.buffers.get(mesh);
    if (!b) {
      b = { p: gl.createBuffer()!, n: gl.createBuffer()!, i: gl.createBuffer()! };
      gl.bindBuffer(gl.ARRAY_BUFFER, b.p);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.n);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      this.buffers.set(mesh, b);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.p);
    gl.enableVertexAttribArray(this.attrs.position);
    gl.vertexAttribPointer(this.attrs.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.n);
    gl.enableVertexAttribArray(this.attrs.normal);
    gl.vertexAttribPointer(this.attrs.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i);
  }

  /** Render part ids to the framebuffer, read one pixel, then leave the normal frame to redraw. */
  private pick(x: number, y: number): PokePreset | null {
    const gl = this.gl,
      dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    const parts = this.scene(this.reduceMotion.matches ? 0 : this.lastTime / 1000);
    this.draw(parts, true);
    const px = new Uint8Array(4);
    gl.readPixels(
      Math.round(x * dpr),
      this.canvas.height - Math.round(y * dpr) - 1,
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      px,
    );
    this.draw(parts, false);
    const id = px[0];
    return id > 0 && id <= PICK_IDS.length ? PICK_IDS[id - 1] : null;
  }

  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private scheduled = false;
  /** Ask for a frame. With motion allowed the loop runs continuously; under reduced motion it draws once per change and stops. */
  private wake() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(t => this.frame(t));
  }
  private frame(now: number) {
    this.scheduled = false;
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0.016;
    this.lastTime = now;
    // Reduced motion: poses still follow the data, but jump there; nothing breathes, beats, or twitches on its own.
    const reduce = this.reduceMotion.matches;
    // Short time constant: the animal reacts within a couple of frames of a new bin, then settles.
    const k = reduce ? 1 : 1 - Math.exp(-dt / 0.09);
    for (const key of ['feed', 'groom', 'escape', 'input', 'approach', 'avoid'] as const)
      this.current[key] += (this.target[key] - this.current[key]) * k;
    if (!reduce) {
      this.beat += dt * 2 * Math.PI * (4 + 14 * this.current.escape);
      this.groomPhase += dt * 2 * Math.PI * (1.2 + 2.2 * this.current.groom);
    }
    this.draw(this.scene(reduce ? 0 : now / 1000), false);
    if (!reduce) this.wake();
  }
}
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

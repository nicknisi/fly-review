import { geometryTransform, normalizePoint } from '../src/brain-geometry.js';
import type { GeometryTransform } from '../src/brain-geometry.js';
import type { ActivePoint3, BrainAnatomy, Mushroom3d, Point3, Readouts3 } from '../src/review-brain.js';

/** Fixed colors for the three readout populations: A feeding (MN9), B grooming (DNg62), C escape (DNp01). */
export const READOUT_COLORS: [number, number, number][] = [
  [0.3, 0.95, 0.55],
  [0.78, 0.55, 1],
  [1, 0.36, 0.3],
];
export const READOUT_CSS = ['oklch(.85 .2 150)', 'oklch(.72 .2 300)', 'oklch(.68 .22 25)'];
/** The mushroom body: Kenyon cells (violet), avoidance MBONs (red), approach MBONs (green). */
export const MB_COLORS = {
  kenyon: [0.62, 0.5, 1] as [number, number, number],
  avoid: [1, 0.36, 0.3] as [number, number, number],
  approach: [0.3, 0.95, 0.55] as [number, number, number],
};
export const MB_CSS = { kenyon: 'oklch(.7 .18 300)', avoid: 'oklch(.68 .22 25)', approach: 'oklch(.85 .2 150)' };
/** The dopamine neurons: PPL1 (punishment, bitter) and PAM (reward, sugar), both pink; they flash only during a lesson. */
export const DAN_COLOR: [number, number, number] = [1, 0.45, 0.85];
export const DAN_CSS = 'oklch(.75 .2 340)';

const VERTEX = `
attribute vec3 position;
attribute float weight;
uniform vec2 rotation;
uniform vec3 center;
uniform float aspect;
uniform float zoom;
uniform float size;
varying float strength;
void main() {
  float cy=cos(rotation.x), sy=sin(rotation.x), cx=cos(rotation.y), sx=sin(rotation.y);
  vec3 q=position-center;
  vec3 p=vec3(q.x*cy+q.z*sy, q.y, -q.x*sy+q.z*cy);
  p=vec3(p.x,p.y*cx-p.z*sx,p.y*sx+p.z*cx);
  float depth=3.5-p.z;
  gl_Position=vec4(p.x*zoom/aspect,p.y*zoom,0.0,depth);
  gl_PointSize=size*(1.0+sqrt(max(0.0,weight))*0.20)/depth;
  strength=weight;
}`;
const FRAGMENT = `
precision mediump float;
uniform vec4 color;
uniform bool points;
uniform bool ring;
void main() {
  float alpha=color.a;
  if(points){
    float r=length(gl_PointCoord-vec2(0.5))*2.0;
    if(r>1.0)discard;
    if(ring){if(r<0.66)discard;}
    else alpha*=pow(1.0-r,1.45);
  }
  gl_FragColor=vec4(color.rgb,alpha);
}`;

type Layer = { buffer: WebGLBuffer; count: number };
export class BrainView {
  canvas: HTMLCanvasElement;
  renderer: 'webgl' | '2d' = '2d';
  anatomy: BrainAnatomy | null = null;
  rotating = false;
  yaw = -0.18;
  pitch = 0.06;
  zoom = 3.0;
  /** Point the camera orbits around, in normalized scene units. Eased toward `target` every frame. */
  center: [number, number, number] = [0, 0, 0];
  private target: { center: [number, number, number]; zoom: number } | null = null;
  private transform: GeometryTransform | null = null;
  private gl: WebGLRenderingContext | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private program: WebGLProgram | null = null;
  private position = -1;
  private weight = -1;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private layers: Layer[] = [];
  private normalized: number[][] = [];
  private activePoints: number[][] = [];
  private readouts: number[][][] = [[], [], []];
  private readoutCounts: number[][] = [[], [], []];
  private mbons: [number[][], number[][]] = [[], []];
  private mbonCounts: [number[], number[]] = [[], []];
  private dans: [number[][], number[][]] = [[], []];
  private danCounts: [number[], number[]] = [[], []];
  private lastDan: number[][] | null = null;
  private kenyonCloud: number[][] = [];
  /** Set by the walkthrough: brighten the mushroom body so the calyces read as a place, not a smear. */
  emphasizeMushroomBody = false;
  private kenyonActive: number[][] = [];
  private lastKenyon: Point3[] | null = null;
  private lastMbon: number[][] | null = null;
  private lastFrame: ActivePoint3[] | null = null;
  private lastReadout: number[][] | null = null;
  private lastTime = 0;
  private onRenderer: (label: string) => void;
  private dragging: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, onRenderer: (label: string) => void) {
    this.canvas = canvas;
    this.onRenderer = onRenderer;
    try {
      const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL unavailable');
      this.gl = gl;
      const shader = (type: number, source: string) => {
        const value = gl.createShader(type);
        if (!value) throw new Error('Shader allocation failed');
        gl.shaderSource(value, source);
        gl.compileShader(value);
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error('WebGL shader compilation failed');
        return value;
      };
      const vertex = shader(gl.VERTEX_SHADER, VERTEX),
        fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
      const program = gl.createProgram();
      if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL program link failed');
      this.program = program;
      this.position = gl.getAttribLocation(program, 'position');
      this.weight = gl.getAttribLocation(program, 'weight');
      for (const key of ['rotation', 'center', 'aspect', 'zoom', 'size', 'color', 'points', 'ring'])
        this.uniforms[key] = gl.getUniformLocation(program, key);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.disable(gl.DEPTH_TEST);
      // 0 anatomy, 1 links, 2 sampled activity, 3-5 readout somas per population, 6-8 spiking readout somas per population,
      // 9 Kenyon-cell sample, 10 active Kenyon cells, 11-12 MBON somas (avoid, approach), 13-14 spiking MBONs (avoid, approach).
      this.layers = Array.from({ length: 19 }, () => {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('Buffer allocation failed');
        return { buffer, count: 0 };
      });
      this.renderer = 'webgl';
      this.canvas.dataset.renderer = 'webgl';
      onRenderer('WebGL · real 3D coordinates');
      canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        this.fallback('WebGL context lost · 2D fallback');
      });
    } catch {
      this.fallback('WebGL unavailable · 2D fallback');
      return;
    }
    this.bindControls();
  }

  private fallback(label: string) {
    // A canvas that acquired a WebGL context cannot acquire a 2D context.
    const replacement = document.createElement('canvas');
    replacement.id = this.canvas.id;
    replacement.className = this.canvas.className;
    replacement.setAttribute(
      'aria-label',
      'Two-dimensional projection of real neuron positions. WebGL is unavailable; the same measured activity is shown.',
    );
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.ctx = replacement.getContext('2d');
    this.gl = null;
    this.program = null;
    this.renderer = '2d';
    replacement.dataset.renderer = '2d';
    this.rotating = false;
    this.onRenderer(label);
    this.bindControls();
  }

  private bindControls() {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerdown', event => {
      if (this.renderer !== 'webgl') return;
      this.canvas.focus({ preventScroll: true });
      this.canvas.setPointerCapture(event.pointerId);
      this.dragging = { x: event.clientX, y: event.clientY };
    });
    this.canvas.addEventListener('pointermove', event => {
      if (!this.dragging) return;
      this.yaw += (event.clientX - this.dragging.x) * 0.008;
      this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch + (event.clientY - this.dragging.y) * 0.006));
      this.dragging = { x: event.clientX, y: event.clientY };
    });
    const end = () => {
      this.dragging = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('keydown', event => {
      if (this.renderer !== 'webgl') return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '0'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') this.yaw -= 0.12;
      if (event.key === 'ArrowRight') this.yaw += 0.12;
      if (event.key === 'ArrowUp') this.pitch = Math.max(-1.1, this.pitch - 0.12);
      if (event.key === 'ArrowDown') this.pitch = Math.min(1.1, this.pitch + 0.12);
      if (event.key === '+' || event.key === '=') {
        this.target = null;
        this.zoom = Math.min(6, this.zoom + 0.2);
      }
      if (event.key === '-') {
        this.target = null;
        this.zoom = Math.max(1.5, this.zoom - 0.2);
      }
      if (event.key === '0') this.resetView();
    });
  }

  resetView() {
    this.yaw = -0.18;
    this.pitch = 0.06;
    this.aim([0, 0, 0], 3);
  }
  /** Ease the camera toward a point and zoom, in normalized scene units. */
  aim(center: [number, number, number], zoom: number) {
    this.target = { center, zoom };
  }
  /** Swoop the camera toward one readout population (0 A, 1 B, 2 C), centering on its busiest soma; null eases back out. */
  focusReadout(population: number | null) {
    if (population === null || !this.readouts[population]?.length) {
      this.target = { center: [0, 0, 0], zoom: 3 };
      return;
    }
    const somas = this.readouts[population],
      counts = this.readoutCounts[population] ?? [];
    const busiest = somas.reduce((best, _, j) => ((counts[j] ?? 0) > (counts[best] ?? 0) ? j : best), 0);
    const [x, y, z] = somas[busiest];
    this.target = { center: [x, y, z], zoom: 5.2 };
  }
  /** Swoop onto the mushroom body (the centroid of the Kenyon-cell sample); false eases back out. */
  focusMushroomBody(on: boolean) {
    if (!on || !this.kenyonCloud.length) {
      this.target = { center: [0, 0, 0], zoom: 3 };
      return;
    }
    const n = this.kenyonCloud.length;
    const c = this.kenyonCloud.reduce<[number, number, number]>(
      (acc, p) => [acc[0] + p[0] / n, acc[1] + p[1] / n, acc[2] + p[2] / n],
      [0, 0, 0],
    );
    this.target = { center: c, zoom: 4.6 };
  }
  setAnatomy(data: BrainAnatomy) {
    if (!data.geometry3d?.length) throw new Error('3D anatomy is missing; run npm run setup');
    this.anatomy = data;
    this.transform = geometryTransform(data.geometry3d);
    this.normalized = data.geometry3d.map(p => [...normalizePoint(p, this.transform!), 0]);
    if (this.gl) {
      this.upload(0, this.normalized.flat());
      const edges = data.links3d.flatMap(link => [
        ...normalizePoint([link[3], link[4], link[5]], this.transform!),
        0,
        ...normalizePoint([link[6], link[7], link[8]], this.transform!),
        0,
      ]);
      this.upload(1, edges);
    }
    this.setReadouts(data.readouts3d ?? null);
    this.setMushroomBody(data.mushroom3d ?? null);
    this.lastFrame = null;
    this.setActivity([]);
  }
  /** The mushroom body at its real positions: a Kenyon-cell sample and every MBON by class. */
  setMushroomBody(mb: Mushroom3d | null) {
    this.kenyonCloud = (mb?.kenyon ?? []).map(p => [...normalizePoint(p, this.transform!), 0]);
    this.mbons = [
      (mb?.avoid ?? []).map(p => [...normalizePoint(p, this.transform!), 0]),
      (mb?.approach ?? []).map(p => [...normalizePoint(p, this.transform!), 0]),
    ];
    this.dans = [
      (mb?.ppl1 ?? []).map(p => [...normalizePoint(p, this.transform!), 0]),
      (mb?.pam ?? []).map(p => [...normalizePoint(p, this.transform!), 0]),
    ];
    if (this.gl) {
      this.upload(9, this.kenyonCloud.flat());
      this.upload(11, this.mbons[0].flat());
      this.upload(12, this.mbons[1].flat());
      this.upload(15, this.dans[0].flat());
      this.upload(16, this.dans[1].flat());
    }
    this.lastKenyon = null;
    this.lastMbon = null;
    this.lastDan = null;
    this.setMushroomActivity(null, null, null);
  }
  /**
   * The odor code, the vote, and the teaching signal in this bin: Kenyon cells that fired, spikes per MBON, and spikes
   * per dopamine neuron ([ppl1..., pam...]), all aligned to setMushroomBody.
   */
  setMushroomActivity(kenyon: Point3[] | null, counts: number[][] | null, dan: number[][] | null = null) {
    if (dan !== this.lastDan) {
      this.lastDan = dan;
      this.danCounts = [0, 1].map(i => this.dans[i].map((_, j) => dan?.[i]?.[j] ?? 0)) as [number[], number[]];
      if (this.gl)
        for (const i of [0, 1])
          this.upload(
            17 + i,
            this.dans[i].flatMap((p, j) => (this.danCounts[i][j] > 0 ? [p[0], p[1], p[2], this.danCounts[i][j]] : [])),
          );
    }
    if (kenyon !== this.lastKenyon) {
      this.lastKenyon = kenyon;
      this.kenyonActive = (kenyon ?? []).map(p => [...normalizePoint(p, this.transform!), 1]);
      if (this.gl) this.upload(10, this.kenyonActive.flat());
    }
    if (counts !== this.lastMbon) {
      this.lastMbon = counts;
      this.mbonCounts = [0, 1].map(i => this.mbons[i].map((_, j) => counts?.[i]?.[j] ?? 0)) as [number[], number[]];
      if (this.gl)
        for (const i of [0, 1])
          this.upload(
            13 + i,
            this.mbons[i].flatMap((p, j) =>
              this.mbonCounts[i][j] > 0 ? [p[0], p[1], p[2], this.mbonCounts[i][j]] : [],
            ),
          );
    }
  }
  /** Real soma positions of the six readout neurons. Drawn as fixed markers even before any trial. */
  setReadouts(readouts: Readouts3 | null) {
    this.readouts = (readouts ?? [[], [], []]).map(population =>
      population.map((p: Point3) => [...normalizePoint(p, this.transform!), 0]),
    );
    if (this.gl) this.readouts.forEach((population, i) => this.upload(3 + i, population.flat()));
    this.lastReadout = null;
    this.setReadoutActivity(null);
  }
  /** Spikes per readout neuron in the displayed bin, aligned to setReadouts order. */
  setReadoutActivity(counts: number[][] | null) {
    if (counts === this.lastReadout) return;
    this.lastReadout = counts;
    this.readoutCounts = this.readouts.map((population, i) => population.map((_, j) => counts?.[i]?.[j] ?? 0));
    if (this.gl)
      this.readouts.forEach((population, i) =>
        this.upload(
          6 + i,
          population.flatMap((p, j) =>
            this.readoutCounts[i][j] > 0 ? [p[0], p[1], p[2], this.readoutCounts[i][j]] : [],
          ),
        ),
      );
  }
  setActivity(points: ActivePoint3[]) {
    if (!this.transform || points === this.lastFrame) return;
    this.lastFrame = points;
    this.activePoints = points.map(p => [...normalizePoint([p[0], p[1], p[2]], this.transform!), Math.min(p[3], 100)]);
    if (this.gl) this.upload(2, this.activePoints.flat());
  }
  private upload(index: number, values: number[]) {
    const gl = this.gl!,
      layer = this.layers[index];
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(values),
      index === 2 || index === 10 || index === 13 || index === 14 || index >= 17 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
    );
    layer.count = values.length / 4;
  }

  draw(now: number, reducedMotion: boolean, disconnected = false) {
    const delta = this.lastTime ? Math.min(100, now - this.lastTime) : 0;
    this.lastTime = now;
    if (this.rotating && !reducedMotion && !this.dragging && this.renderer === 'webgl') this.yaw += delta * 0.00008;
    if (this.target) {
      // Critically damped-ish easing toward the target; reduced motion jumps straight there.
      const k = reducedMotion ? 1 : Math.min(1, delta * 0.0045);
      this.center = this.center.map((c, i) => c + (this.target!.center[i] - c) * k) as [number, number, number];
      this.zoom += (this.target.zoom - this.zoom) * k;
      if (
        Math.abs(this.zoom - this.target.zoom) < 0.002 &&
        this.center.every((c, i) => Math.abs(c - this.target!.center[i]) < 0.0005)
      ) {
        this.center = [...this.target.center];
        this.zoom = this.target.zoom;
        this.target = null;
      }
    }
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * dpr)),
      height = Math.max(1, Math.round(bounds.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.gl && this.program) {
      const gl = this.gl;
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.009, 0.009, 0.009, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.rotation, this.yaw, this.pitch);
      gl.uniform3f(this.uniforms.center, this.center[0], this.center[1], this.center[2]);
      gl.uniform1f(this.uniforms.aspect, width / height);
      gl.uniform1f(this.uniforms.zoom, this.zoom);
      const layer = (index: number, points: boolean, color: number[], size: number, ring = false) => {
        const data = this.layers[index];
        if (!data.count) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, data.buffer);
        gl.enableVertexAttribArray(this.position);
        gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 16, 0);
        if (this.weight >= 0) {
          gl.enableVertexAttribArray(this.weight);
          gl.vertexAttribPointer(this.weight, 1, gl.FLOAT, false, 16, 12);
        }
        gl.uniform1i(this.uniforms.points, points ? 1 : 0);
        gl.uniform1i(this.uniforms.ring, ring ? 1 : 0);
        gl.uniform4f(this.uniforms.color, color[0], color[1], color[2], color[3]);
        gl.uniform1f(this.uniforms.size, size * dpr);
        gl.drawArrays(points ? gl.POINTS : gl.LINES, 0, data.count);
      };
      // X-ray point cloud: additive blending, not opaque cell surfaces or reconstructed nerve shapes.
      layer(1, false, [0.65, 0.65, 0.7, disconnected ? 0.018 : 0.075], 1);
      layer(0, true, [0.9, 0.9, 0.94, 0.85], 8);
      layer(2, true, disconnected ? [0.4, 0.73, 1, 0.95] : [1, 0.68, 0.15, 1], 27);
      // The mushroom body: a faint Kenyon-cell cloud, the cells carrying this odor lit, MBON rings by class, flashing on spikes.
      const emphasis = this.emphasizeMushroomBody;
      layer(9, true, [...MB_COLORS.kenyon, disconnected ? 0.12 : emphasis ? 0.8 : 0.28], emphasis ? 15 : 9);
      layer(10, true, [...MB_COLORS.kenyon, 1], 20);
      layer(11, true, [...MB_COLORS.avoid, 0.7], 18, true);
      layer(12, true, [...MB_COLORS.approach, 0.7], 18, true);
      layer(13, true, [...MB_COLORS.avoid, 1], 40);
      layer(14, true, [...MB_COLORS.approach, 1], 40);
      // The dopamine neurons: faint pink rings (PPL1 small, PAM many), flashing pink when a lesson makes them fire.
      layer(15, true, [...DAN_COLOR, disconnected ? 0.15 : 0.45], 14, true);
      layer(16, true, [...DAN_COLOR, disconnected ? 0.08 : 0.16], 7, true);
      layer(17, true, [...DAN_COLOR, 1], 44);
      layer(18, true, [...DAN_COLOR, 1], 30);
      // Readout somas: a steady marker per population, then a bright flash sized by this bin's spike count.
      for (let i = 0; i < 3; i++) {
        const [r, g, b] = READOUT_COLORS[i];
        layer(3 + i, true, [r, g, b, 0.85], 30, true);
        layer(6 + i, true, [r, g, b, 1], 64);
      }
    } else if (this.ctx) {
      const ctx = this.ctx;
      ctx.fillStyle = 'oklch(.1 0 0)';
      ctx.fillRect(0, 0, width, height);
      const scale = Math.min(width * 0.4, height * 0.43);
      ctx.fillStyle = 'oklch(.84 0 0 / .7)';
      for (const p of this.normalized)
        ctx.fillRect(width / 2 + p[0] * scale, height / 2 - p[1] * scale, 1.6 * dpr, 1.6 * dpr);
      ctx.fillStyle = disconnected ? 'oklch(.8 .1 230)' : 'oklch(.87 .16 85)';
      for (const p of this.activePoints) {
        ctx.beginPath();
        ctx.arc(
          width / 2 + p[0] * scale,
          height / 2 - p[1] * scale,
          Math.min(5, 1 + Math.sqrt(p[3]) * 0.25) * dpr,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = MB_CSS.kenyon;
      for (const p of this.kenyonActive)
        ctx.fillRect(width / 2 + p[0] * scale, height / 2 - p[1] * scale, 2.2 * dpr, 2.2 * dpr);
      (['avoid', 'approach'] as const).forEach((cls, i) =>
        this.mbons[i].forEach((p, j) => {
          const x = width / 2 + p[0] * scale,
            y = height / 2 - p[1] * scale,
            count = this.mbonCounts[i][j];
          ctx.strokeStyle = MB_CSS[cls];
          ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2);
          ctx.stroke();
          if (count > 0) {
            ctx.fillStyle = MB_CSS[cls];
            ctx.beginPath();
            ctx.arc(x, y, Math.min(6, 2 + count * 0.4) * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
        }),
      );
      this.dans.forEach((population, i) =>
        population.forEach((p, j) => {
          const x = width / 2 + p[0] * scale,
            y = height / 2 - p[1] * scale,
            count = this.danCounts[i][j];
          ctx.strokeStyle = DAN_CSS;
          ctx.lineWidth = 0.8 * dpr;
          ctx.beginPath();
          ctx.arc(x, y, (i === 0 ? 2.5 : 1.6) * dpr, 0, Math.PI * 2);
          ctx.stroke();
          if (count > 0) {
            ctx.fillStyle = DAN_CSS;
            ctx.beginPath();
            ctx.arc(x, y, Math.min(6, 2 + count * 0.6) * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
        }),
      );
      this.readouts.forEach((population, i) =>
        population.forEach((p, j) => {
          const x = width / 2 + p[0] * scale,
            y = height / 2 - p[1] * scale,
            count = this.readoutCounts[i][j];
          ctx.strokeStyle = READOUT_CSS[i];
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
          ctx.stroke();
          if (count > 0) {
            ctx.fillStyle = READOUT_CSS[i];
            ctx.beginPath();
            ctx.arc(x, y, Math.min(9, 3 + count * 0.5) * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
        }),
      );
    }
  }
}

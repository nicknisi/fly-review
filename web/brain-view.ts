import { geometryTransform, normalizePoint } from '../src/brain-geometry.js';
import type { GeometryTransform } from '../src/brain-geometry.js';
import type { ActivePoint3, BrainAnatomy } from '../src/review-brain.js';

const VERTEX = `
attribute vec3 position;
attribute float weight;
uniform vec2 rotation;
uniform float aspect;
uniform float zoom;
uniform float size;
varying float strength;
void main() {
  float cy=cos(rotation.x), sy=sin(rotation.x), cx=cos(rotation.y), sx=sin(rotation.y);
  vec3 p=vec3(position.x*cy+position.z*sy, position.y, -position.x*sy+position.z*cy);
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
void main() {
  float alpha=color.a;
  if(points){float r=length(gl_PointCoord-vec2(0.5))*2.0;if(r>1.0)discard;alpha*=pow(1.0-r,1.45);}
  gl_FragColor=vec4(color.rgb,alpha);
}`;

type Layer = { buffer: WebGLBuffer; count: number };
export class BrainView {
  canvas: HTMLCanvasElement;
  renderer: 'webgl' | '2d' = '2d';
  anatomy: BrainAnatomy | null = null;
  rotating = false;
  yaw = -.18;
  pitch = .06;
  zoom = 3.0;
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
  private lastFrame: ActivePoint3[] | null = null;
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
        gl.shaderSource(value, source); gl.compileShader(value);
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error('WebGL shader compilation failed');
        return value;
      };
      const vertex = shader(gl.VERTEX_SHADER, VERTEX), fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
      const program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL program link failed');
      this.program = program;
      this.position = gl.getAttribLocation(program, 'position'); this.weight = gl.getAttribLocation(program, 'weight');
      for (const key of ['rotation','aspect','zoom','size','color','points']) this.uniforms[key] = gl.getUniformLocation(program, key);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.disable(gl.DEPTH_TEST);
      this.layers = Array.from({ length: 3 }, () => { const buffer = gl.createBuffer(); if (!buffer) throw new Error('Buffer allocation failed'); return { buffer, count: 0 }; });
      this.renderer = 'webgl'; this.canvas.dataset.renderer = 'webgl'; onRenderer('WebGL · real 3D coordinates');
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.fallback('WebGL context lost · 2D fallback'); });
    } catch { this.fallback('WebGL unavailable · 2D fallback'); return; }
    this.bindControls();
  }

  private fallback(label: string) {
    // A canvas that acquired a WebGL context cannot acquire a 2D context.
    const replacement = document.createElement('canvas');
    replacement.id = this.canvas.id; replacement.className = this.canvas.className;
    replacement.setAttribute('aria-label', 'Two-dimensional projection of real neuron positions. WebGL is unavailable; the same measured activity is shown.');
    this.canvas.replaceWith(replacement); this.canvas = replacement;
    this.ctx = replacement.getContext('2d'); this.gl = null; this.program = null;
    this.renderer = '2d'; replacement.dataset.renderer = '2d'; this.rotating = false;
    this.onRenderer(label);
    this.bindControls();
  }

  private bindControls() {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerdown', event => {
      if (this.renderer !== 'webgl') return;
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      this.dragging = { x: event.clientX, y: event.clientY };
    });
    this.canvas.addEventListener('pointermove', event => {
      if (!this.dragging) return;
      this.yaw += (event.clientX - this.dragging.x) * .008;
      this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch + (event.clientY - this.dragging.y) * .006));
      this.dragging = { x: event.clientX, y: event.clientY };
    });
    const end = () => { this.dragging = null; };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('keydown', event => {
      if (this.renderer !== 'webgl') return;
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') this.yaw -= .12;
      if (event.key === 'ArrowRight') this.yaw += .12;
      if (event.key === 'ArrowUp') this.pitch = Math.max(-1.1, this.pitch - .12);
      if (event.key === 'ArrowDown') this.pitch = Math.min(1.1, this.pitch + .12);
      if (event.key === '+' || event.key === '=') this.zoom = Math.min(5, this.zoom + .2);
      if (event.key === '-') this.zoom = Math.max(1.5, this.zoom - .2);
      if (event.key === '0') this.resetView();
    });
  }

  resetView() { this.yaw = -.18; this.pitch = .06; this.zoom = 3; }
  setAnatomy(data: BrainAnatomy) {
    if (!data.geometry3d?.length) throw new Error('3D anatomy is missing; run npm run setup');
    this.anatomy = data; this.transform = geometryTransform(data.geometry3d);
    this.normalized = data.geometry3d.map(p => [...normalizePoint(p, this.transform!), 0]);
    if (this.gl) {
      this.upload(0, this.normalized.flat());
      const edges = data.links3d.flatMap(link => [
        ...normalizePoint([link[3],link[4],link[5]], this.transform!), 0,
        ...normalizePoint([link[6],link[7],link[8]], this.transform!), 0,
      ]);
      this.upload(1, edges);
    }
    this.lastFrame = null; this.setActivity([]);
  }
  setActivity(points: ActivePoint3[]) {
    if (!this.transform || points === this.lastFrame) return;
    this.lastFrame = points;
    this.activePoints = points.map(p => [...normalizePoint([p[0],p[1],p[2]], this.transform!), Math.min(p[3],100)]);
    if (this.gl) this.upload(2, this.activePoints.flat());
  }
  private upload(index: number, values: number[]) {
    const gl = this.gl!, layer = this.layers[index];
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), index === 2 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    layer.count = values.length / 4;
  }

  draw(now: number, reducedMotion: boolean, disconnected = false) {
    const delta = this.lastTime ? Math.min(100, now - this.lastTime) : 0; this.lastTime = now;
    if (this.rotating && !reducedMotion && !this.dragging && this.renderer === 'webgl') this.yaw += delta * .00008;
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * dpr)), height = Math.max(1, Math.round(bounds.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    if (this.gl && this.program) {
      const gl = this.gl;
      gl.viewport(0,0,width,height); gl.clearColor(.009,.009,.009,1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.rotation, this.yaw, this.pitch); gl.uniform1f(this.uniforms.aspect, width/height); gl.uniform1f(this.uniforms.zoom, this.zoom);
      const layer = (index: number, points: boolean, color: number[], size: number) => {
        const data = this.layers[index]; if (!data.count) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, data.buffer);
        gl.enableVertexAttribArray(this.position); gl.vertexAttribPointer(this.position,3,gl.FLOAT,false,16,0);
        if (this.weight >= 0) { gl.enableVertexAttribArray(this.weight); gl.vertexAttribPointer(this.weight,1,gl.FLOAT,false,16,12); }
        gl.uniform1i(this.uniforms.points, points ? 1 : 0); gl.uniform4f(this.uniforms.color,color[0],color[1],color[2],color[3]); gl.uniform1f(this.uniforms.size,size*dpr);
        gl.drawArrays(points ? gl.POINTS : gl.LINES,0,data.count);
      };
      // X-ray point cloud: additive blending, not opaque cell surfaces or reconstructed nerve shapes.
      layer(1,false,[.65,.65,.70,disconnected ? .018 : .075],1);
      layer(0,true,[.90,.90,.94,.85],8);
      layer(2,true,disconnected ? [.40,.73,1,.95] : [1,.68,.15,1],27);
    } else if (this.ctx) {
      const ctx = this.ctx; ctx.fillStyle = 'oklch(.1 0 0)'; ctx.fillRect(0,0,width,height);
      const scale = Math.min(width*.40,height*.43);
      ctx.fillStyle = 'oklch(.84 0 0 / .7)';
      for (const p of this.normalized) ctx.fillRect(width/2+p[0]*scale,height/2-p[1]*scale,1.6*dpr,1.6*dpr);
      ctx.fillStyle = disconnected ? 'oklch(.8 .1 230)' : 'oklch(.87 .16 85)';
      for (const p of this.activePoints) { ctx.beginPath(); ctx.arc(width/2+p[0]*scale,height/2-p[1]*scale,Math.min(5,1+Math.sqrt(p[3])*.25)*dpr,0,Math.PI*2); ctx.fill(); }
    }
  }
}

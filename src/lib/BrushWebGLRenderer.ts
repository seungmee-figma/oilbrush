/**
 * WebGL2 rendering engine for brush bristle segments.
 *
 * Renders each bristle segment as an oriented quad with capsule SDF
 * anti-aliasing in the fragment shader.
 */

// ── Shaders ──────────────────────────────────────────────────────────

const SEGMENT_VERT = `#version 300 es
precision highp float;

in vec2 a_quad;
in vec2 a_p1;
in vec2 a_p2;
in float a_thick;
in vec4 a_color;

uniform vec2 u_res;

out vec2 v_world;
out vec2 v_p1;
out vec2 v_p2;
out float v_radius;
out vec4 v_color;

void main() {
    vec2 d = a_p2 - a_p1;
    float len = length(d);
    vec2 dir = len > 0.001 ? d / len : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);

    float r = a_thick * 0.5 + 1.0;

    vec2 pos = a_p1
             + dir  * (a_quad.x * (len + 2.0 * r) - r)
             + perp * (a_quad.y * 2.0 - 1.0) * r;

    v_world  = pos;
    v_p1     = a_p1;
    v_p2     = a_p2;
    v_radius = a_thick * 0.5;
    v_color  = a_color;

    vec2 clip = (pos / u_res) * 2.0 - 1.0;
    clip.y *= -1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const SEGMENT_FRAG = `#version 300 es
precision highp float;

in vec2 v_world;
in vec2 v_p1;
in vec2 v_p2;
in float v_radius;
in vec4 v_color;

out vec4 fragColor;

void main() {
    vec2 pa = v_world - v_p1;
    vec2 ba = v_p2 - v_p1;
    float lenSq = dot(ba, ba);
    float h = lenSq > 0.0 ? clamp(dot(pa, ba) / lenSq, 0.0, 1.0) : 0.0;
    float d = length(pa - ba * h) - v_radius;

    float a = 1.0 - smoothstep(-0.5, 0.5, d);
    if (a < 0.004) discard;

    fragColor = vec4(v_color.rgb, v_color.a * a);
}`;

const DISPLAY_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const DISPLAY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
    fragColor = texture(u_tex, v_uv);
}`;

// ── Helpers ──────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("Shader compile error: " + info);
  }
  return s;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vSrc: string,
  fSrc: string
) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error("Program link error: " + info);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function hexToGL(hex: string): [number, number, number, number] {
  hex = hex.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    1.0,
  ];
}

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

const FLOATS_PER_VERT = 11;
const VERTS_PER_SEG = 6;
const FLOATS_PER_SEG = FLOATS_PER_VERT * VERTS_PER_SEG;
const MAX_SEGMENTS = 8192;

export interface BristleSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export class BrushWebGLRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null = null;
  width = 0;
  height = 0;

  private segProg: WebGLProgram | null = null;
  private dispProg: WebGLProgram | null = null;
  private segVAO: WebGLVertexArrayObject | null = null;
  private segVBO: WebGLBuffer | null = null;
  private vertexData = new Float32Array(MAX_SEGMENTS * FLOATS_PER_SEG);
  private dispVAO: WebGLVertexArrayObject | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private _pixelBuf: Uint8Array | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private uTex: WebGLUniformLocation | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  init(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    })!;
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    this.segProg = createProgram(gl, SEGMENT_VERT, SEGMENT_FRAG);
    this.dispProg = createProgram(gl, DISPLAY_VERT, DISPLAY_FRAG);

    this.uRes = gl.getUniformLocation(this.segProg, "u_res");
    this.uTex = gl.getUniformLocation(this.dispProg, "u_tex");

    this._initSegmentBuffers();
    this._initDisplayQuad();
    this._initFramebuffer();

    this._pixelBuf = new Uint8Array(w * h * 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private _initSegmentBuffers() {
    const gl = this.gl!;
    this.segVAO = gl.createVertexArray();
    gl.bindVertexArray(this.segVAO);

    this.segVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERT * 4;
    const locs = {
      quad: gl.getAttribLocation(this.segProg!, "a_quad"),
      p1: gl.getAttribLocation(this.segProg!, "a_p1"),
      p2: gl.getAttribLocation(this.segProg!, "a_p2"),
      thick: gl.getAttribLocation(this.segProg!, "a_thick"),
      color: gl.getAttribLocation(this.segProg!, "a_color"),
    };

    gl.enableVertexAttribArray(locs.quad);
    gl.vertexAttribPointer(locs.quad, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(locs.p1);
    gl.vertexAttribPointer(locs.p1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(locs.p2);
    gl.vertexAttribPointer(locs.p2, 2, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(locs.thick);
    gl.vertexAttribPointer(locs.thick, 1, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(locs.color);
    gl.vertexAttribPointer(locs.color, 4, gl.FLOAT, false, stride, 28);

    gl.bindVertexArray(null);
  }

  private _initDisplayQuad() {
    const gl = this.gl!;
    this.dispVAO = gl.createVertexArray();
    gl.bindVertexArray(this.dispVAO);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW
    );

    const loc = gl.getAttribLocation(this.dispProg!, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  private _initFramebuffer() {
    const gl = this.gl!;
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.fboTex,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  clear(bgColorHex: string) {
    const gl = this.gl!;
    const c = hexToGL(bgColorHex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(c[0], c[1], c[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  renderSegments(segments: BristleSegment[]) {
    if (!segments.length) return;
    const gl = this.gl!;
    const count = Math.min(segments.length, MAX_SEGMENTS);
    const buf = this.vertexData;
    let off = 0;

    for (let s = 0; s < count; s++) {
      const seg = segments[s];
      const r = seg.r / 255;
      const g = seg.g / 255;
      const b = seg.b / 255;
      const a = seg.a;

      for (let v = 0; v < VERTS_PER_SEG; v++) {
        const qi = v * 2;
        buf[off++] = QUAD[qi];
        buf[off++] = QUAD[qi + 1];
        buf[off++] = seg.x1;
        buf[off++] = seg.y1;
        buf[off++] = seg.x2;
        buf[off++] = seg.y2;
        buf[off++] = seg.thickness;
        buf[off++] = r;
        buf[off++] = g;
        buf[off++] = b;
        buf[off++] = a;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.segProg);
    gl.uniform2f(this.uRes!, this.width, this.height);
    gl.bindVertexArray(this.segVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, off);
    gl.drawArrays(gl.TRIANGLES, 0, count * VERTS_PER_SEG);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  display() {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.dispProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.uTex!, 0);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.dispVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
  }

  readPixels(): Uint8Array {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(
      0,
      0,
      this.width,
      this.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this._pixelBuf!
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this._pixelBuf!;
  }

  getPixelAt(
    pixels: Uint8Array,
    x: number,
    y: number
  ): { r: number; g: number; b: number } {
    const flippedY = this.height - 1 - y;
    const i = 4 * (flippedY * this.width + x);
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl!;
    gl.deleteTexture(this.fboTex);
    gl.deleteFramebuffer(this.fbo);
    this._initFramebuffer();
    this._pixelBuf = new Uint8Array(w * h * 4);
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteFramebuffer(this.fbo);
    gl.deleteTexture(this.fboTex);
    gl.deleteProgram(this.segProg);
    gl.deleteProgram(this.dispProg);
    gl.deleteVertexArray(this.segVAO);
    gl.deleteVertexArray(this.dispVAO);
    gl.deleteBuffer(this.segVBO);
    this.gl = null;
  }
}

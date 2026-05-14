/**
 * Web Worker: WebGL2 pre-render of brush strokes on OffscreenCanvas.
 *
 * Uses Transform Feedback for GPU-side color mixing — zero readPixels.
 * Uses instanced rendering — 7 floats per segment instead of 54.
 * CPU handles bristle chain physics with SoA TypedArray layout.
 *
 * Input:  { pathPointsArray, config }
 * Output: { type:'progress', value } | { type:'complete', bitmap } | { type:'error', message }
 */

// ══════════════════════════════════════════════════════════════════════
//  Perlin Noise
// ══════════════════════════════════════════════════════════════════════

class PerlinNoise {
    constructor() {
        this.S = 4096;
        this.t = new Float32Array(this.S + 1);
        for (let i = 0; i < this.S + 1; i++) this.t[i] = Math.random();
    }
    noise(x) {
        if (x < 0) x = -x;
        let xi = Math.floor(x), xf = x - xi, r = 0, a = 0.5;
        for (let o = 0; o < 4; o++) {
            const i = (xi >> 0) & (this.S - 1);
            const rx = 0.5 * (1 - Math.cos(xf * Math.PI));
            r += (this.t[i] + rx * (this.t[i + 1] - this.t[i])) * a;
            a *= 0.5;
            xi = Math.floor(x * (1 << (o + 1)));
            xf = x * (1 << (o + 1)) - xi;
        }
        return r;
    }
}
const perlin = new PerlinNoise();

// ══════════════════════════════════════════════════════════════════════
//  Utilities
// ══════════════════════════════════════════════════════════════════════

function rnd(a, b) { if (b === undefined) { b = a; a = 0; } return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function parseHex(h) { h = h.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }

function applyPathNoise(paths, seed, amplitude) {
    if (!amplitude) return paths;
    const ng = new PerlinNoise();
    return paths.map((pts, pi) =>
        pts.map((p, i) => {
            const t = i / (pts.length || 1);
            const nx = (ng.noise(seed + pi * 97 + t * 8) - 0.5) * 2 * amplitude;
            const ny = (ng.noise(seed + pi * 97 + t * 8 + 500) - 0.5) * 2 * amplitude;
            return { x: p.x + nx, y: p.y + ny };
        })
    );
}

function rotatePaths(paths, angle) {
    if (!angle) return paths;
    let cx = 0, cy = 0, count = 0;
    for (const pts of paths) for (const p of pts) { cx += p.x; cy += p.y; count++; }
    cx /= count; cy /= count;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return paths.map(pts =>
        pts.map(p => {
            const dx = p.x - cx, dy = p.y - cy;
            return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
        })
    );
}

// ══════════════════════════════════════════════════════════════════════
//  SoA Brush — flat TypedArray layout, instanced write
// ══════════════════════════════════════════════════════════════════════

let JOINTS = 4;
let SEGS_PER_BRISTLE = JOINTS - 1;
let MAX_BRISTLE_COUNT = 120;

class Brush {
    constructor(size, dur, cfg) {
        this.nBristles = Math.min(Math.round(size * rnd(1.6, 1.9)), MAX_BRISTLE_COUNT);
        const N = this.nBristles, J = JOINTS;

        this.chainX = new Float64Array(N * J);
        this.chainY = new Float64Array(N * J);
        this.chainLen = new Float64Array(N * J);
        this.chainThk = new Float64Array(N * J);

        const bLen = Math.min(size, 15);
        const nE = SEGS_PER_BRISTLE;
        const bT = Math.min(0.8 * bLen, 5);
        const dec = bT / nE;
        for (let b = 0; b < N; b++) {
            const base = b * J;
            for (let j = 0; j < J; j++) {
                this.chainLen[base + j] = J - j;
                this.chainThk[base + j] = bT - (j - 1) * dec;
            }
        }

        this.bOffX = new Float64Array(N);
        this.bOffY = new Float64Array(N);
        this.bPosX = new Float64Array(N);
        this.bPosY = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            this.bOffX[i] = size * rnd(-0.5, 0.5);
            this.bOffY[i] = 8 * rnd(-0.5, 0.5);
        }

        this.colR = new Float64Array(N);
        this.colG = new Float64Array(N);
        this.colB = new Float64Array(N);

        this._regionBuf = new Uint8Array(1024 * 128 * 4);

        this.colorChange = 55;
        this.baseMix = cfg.mixStrength != null ? cfg.mixStrength : (cfg.svgType === 'line' ? 0.005 : 0.08);
        const liveMixPerFrame = this.baseMix * (5000 / dur);
        const numPaths = cfg.numPaths || 22;
        const framesPerPath = (dur / numPaths) / 16.667;
        const pointsPerPath = cfg.pointsPerPath || 1842;
        const readEvery = cfg.readEvery || 10;
        const totalMix = 1 - Math.pow(1 - liveMixPerFrame, framesPerPath);
        const tfUpdates = Math.max(1, Math.ceil(pointsPerPath / readEvery));
        this.mixStr = 1 - Math.pow(1 - totalMix, 1 / tfUpdates);

        this.minAlpha = 20; this.curColor = null;
        this.speed = 0; this.maxSpeed = 10; this.lastAngle = 0;
        this.posX = 0; this.posY = 0;
        this.prevX = 0; this.prevY = 0;
    }

    updateColor(hex) {
        if (this.curColor === hex) return; this.curColor = hex;
        const { r, g, b } = parseHex(hex); const seed = rnd(1000);
        for (let i = 0; i < this.nBristles; i++) {
            const d = this.colorChange * (perlin.noise(seed + 0.4 * i) - 0.5);
            this.colR[i] = clamp(r + d, 0, 255);
            this.colG[i] = clamp(g + d, 0, 255);
            this.colB[i] = clamp(b + d, 0, 255);
        }
    }

    init(p, hex) {
        this.posX = p.x; this.posY = p.y;
        this.prevX = p.x; this.prevY = p.y;
        this._bristlePos(0, 1);
        this.updateColor(hex);
        const N = this.nBristles, J = JOINTS;
        for (let b = 0; b < N; b++) {
            const base = b * J;
            const bx = this.bPosX[b], by = this.bPosY[b];
            for (let j = 0; j < J; j++) {
                this.chainX[base + j] = bx;
                this.chainY[base + j] = by;
            }
        }
    }

    update(np, alpha, next) {
        this.prevX = this.posX; this.prevY = this.posY;
        this.posX = np.x; this.posY = np.y;
        const dx = this.posX - this.prevX, dy = this.posY - this.prevY;
        this.speed = Math.min(Math.sqrt(dx * dx + dy * dy), this.maxSpeed);
        let da = this.lastAngle;
        if (next) {
            const nx = next.x - np.x, ny = next.y - np.y;
            if (Math.abs(nx) > 0.01 || Math.abs(ny) > 0.01) {
                da = Math.atan2(ny, nx) + Math.PI / 2;
                this.lastAngle = da;
            }
        }
        const sp = 1 + (this.speed / this.maxSpeed) * 0.5;
        this._bristlePos(da, sp);
        this._updateChains();
    }

    _bristlePos(ang, sp) {
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const px = this.posX, py = this.posY;
        const N = this.nBristles;
        for (let i = 0; i < N; i++) {
            const x = this.bOffX[i] * sp, y = this.bOffY[i] * sp;
            this.bPosX[i] = px + (x * cos - y * sin);
            this.bPosY[i] = py + (x * sin + y * cos);
        }
    }

    _updateChains() {
        const N = this.nBristles, J = JOINTS;
        const cx = this.chainX, cy = this.chainY, cl = this.chainLen;
        const bpx = this.bPosX, bpy = this.bPosY;
        for (let b = 0; b < N; b++) {
            const base = b * J;
            cx[base] = bpx[b];
            cy[base] = bpy[b];
            for (let j = 1; j < J; j++) {
                const idx = base + j, prevIdx = idx - 1;
                const pdx = cx[prevIdx] - cx[idx];
                const pdy = cy[prevIdx] - cy[idx];
                const a = Math.atan2(pdy, pdx);
                cx[idx] = cx[prevIdx] - cl[idx] * Math.cos(a);
                cy[idx] = cy[prevIdx] - cl[idx] * Math.sin(a);
            }
        }
    }

    getReadRegion(logW, physW, physH) {
        let minCol = Infinity, maxCol = 0, minRow = Infinity, maxRow = 0;
        const N = this.nBristles;
        const coords = new Array(N);
        for (let i = 0; i < N; i++) {
            const col = Math.round(this.bPosX[i]) * 2;
            const row = Math.round(this.bPosY[i]) * 2;
            coords[i] = { col, row };
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
        }
        minCol = Math.max(0, minCol);
        minRow = Math.max(0, minRow);
        maxCol = Math.min(physW - 1, maxCol);
        maxRow = Math.min(physH - 1, maxRow);
        const rw = maxCol - minCol + 1;
        const rh = maxRow - minRow + 1;
        if (rw <= 0 || rh <= 0) return null;
        return { minCol, maxRow, rw, rh, fboY: physH - 1 - maxRow, coords };
    }

    applyMix(buf, region) {
        const { minCol, maxRow, rw, rh, coords } = region;
        const sm = 1 + (this.speed / this.maxSpeed) * 0.5;
        const m = this.mixStr * sm, f = 1 - m;
        for (let i = 0; i < this.nBristles; i++) {
            const lc = coords[i].col - minCol;
            const lr = maxRow - coords[i].row;
            if (lc >= 0 && lc < rw && lr >= 0 && lr < rh) {
                const idx = 4 * (lr * rw + lc);
                this.colR[i] = f * this.colR[i] + m * buf[idx];
                this.colG[i] = f * this.colG[i] + m * buf[idx + 1];
                this.colB[i] = f * this.colB[i] + m * buf[idx + 2];
            }
        }
    }

    // Instanced write for non-TF mode: 9 floats per instance
    writeInstances(vData, floatOff, alpha) {
        const a = alpha / 255;
        const N = this.nBristles, J = JOINTS;
        const cx = this.chainX, cy = this.chainY, ct = this.chainThk;
        let off = floatOff;
        for (let b = 0; b < N; b++) {
            const base = b * J;
            const r = this.colR[b] / 255, g = this.colG[b] / 255, bl = this.colB[b] / 255;
            for (let j = 1; j < J; j++) {
                vData[off]   = cx[base + j - 1]; vData[off+1] = cy[base + j - 1];
                vData[off+2] = cx[base + j];     vData[off+3] = cy[base + j];
                vData[off+4] = ct[base + j];
                vData[off+5] = r; vData[off+6] = g; vData[off+7] = bl; vData[off+8] = a;
                off += IFP;
            }
        }
        return off;
    }

    // Instanced write for TF mode: 7 floats per instance
    writeInstancesTF(vData, floatOff, alpha, bristleIdxOffset) {
        const a = alpha / 255;
        const N = this.nBristles, J = JOINTS;
        const cx = this.chainX, cy = this.chainY, ct = this.chainThk;
        let off = floatOff;
        for (let b = 0; b < N; b++) {
            const base = b * J;
            const bIdx = bristleIdxOffset + b + 0.5;
            for (let j = 1; j < J; j++) {
                vData[off]   = cx[base + j - 1]; vData[off+1] = cy[base + j - 1];
                vData[off+2] = cx[base + j];     vData[off+3] = cy[base + j];
                vData[off+4] = ct[base + j];
                vData[off+5] = bIdx;
                vData[off+6] = a;
                off += IFP_TF;
            }
        }
        return off;
    }
}

// ══════════════════════════════════════════════════════════════════════
//  Shaders — instanced rendering, quad from gl_VertexID
// ══════════════════════════════════════════════════════════════════════

const SEG_V = `#version 300 es
precision highp float;
in vec2 a_p1; in vec2 a_p2; in float a_thick; in vec4 a_color;
uniform vec2 u_res;
out vec2 v_w; out vec2 v_a; out vec2 v_b; out float v_r; out vec4 v_c;
const vec2 Q[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(1,0),vec2(1,1),vec2(0,1));
void main(){
    vec2 q=Q[gl_VertexID%6];
    vec2 d=a_p2-a_p1; float l=length(d);
    vec2 dir=l>0.001?d/l:vec2(1,0); vec2 perp=vec2(-dir.y,dir.x);
    float r=a_thick*0.5+1.0;
    vec2 pos=a_p1+dir*(q.x*(l+2.0*r)-r)+perp*(q.y*2.0-1.0)*r;
    v_w=pos; v_a=a_p1; v_b=a_p2; v_r=a_thick*0.5; v_c=a_color;
    vec2 c=(pos/u_res)*2.0-1.0; c.y*=-1.0; gl_Position=vec4(c,0,1);
}`;
const SEG_F = `#version 300 es
precision highp float;
in vec2 v_w; in vec2 v_a; in vec2 v_b; in float v_r; in vec4 v_c;
out vec4 fc;
void main(){
    vec2 pa=v_w-v_a,ba=v_b-v_a; float ls=dot(ba,ba);
    float h=ls>0.0?clamp(dot(pa,ba)/ls,0.0,1.0):0.0;
    float d=length(pa-ba*h)-v_r;
    float a=1.0-smoothstep(-0.5,0.5,d); if(a<0.004)discard;
    fc=vec4(v_c.rgb,v_c.a*a);
}`;

const SEG_TF_V = `#version 300 es
precision highp float;
in vec2 a_p1; in vec2 a_p2; in float a_thick;
in float a_bristleIdx; in float a_alpha;
uniform vec2 u_res;
uniform sampler2D u_colorTex;
out vec2 v_w; out vec2 v_a; out vec2 v_b; out float v_r; out vec4 v_c;
const vec2 Q[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(1,0),vec2(1,1),vec2(0,1));
void main(){
    vec2 q=Q[gl_VertexID%6];
    vec2 d=a_p2-a_p1; float l=length(d);
    vec2 dir=l>0.001?d/l:vec2(1,0); vec2 perp=vec2(-dir.y,dir.x);
    float r=a_thick*0.5+1.0;
    vec2 pos=a_p1+dir*(q.x*(l+2.0*r)-r)+perp*(q.y*2.0-1.0)*r;
    v_w=pos; v_a=a_p1; v_b=a_p2; v_r=a_thick*0.5;
    vec4 col=texelFetch(u_colorTex,ivec2(int(a_bristleIdx),0),0);
    v_c=vec4(col.rgb,a_alpha);
    vec2 c=(pos/u_res)*2.0-1.0; c.y*=-1.0; gl_Position=vec4(c,0,1);
}`;

const TF_V = `#version 300 es
precision highp float;
in vec2 a_samplePos;
in vec3 a_curColor;
uniform sampler2D u_canvasTex;
uniform vec2 u_canvasSize;
uniform float u_mixStr;
uniform vec3 u_bgColor;
out vec3 v_newColor;
void main(){
    vec2 uv = a_samplePos / u_canvasSize;
    uv.y = 1.0 - uv.y;
    vec4 canvas = texture(u_canvasTex, uv);
    v_newColor = mix(a_curColor, canvas.rgb, u_mixStr);
    v_newColor = mix(v_newColor, u_bgColor, u_mixStr * 0.2);
    gl_Position = vec4(0,0,0,1);
    gl_PointSize = 1.0;
}`;
const TF_F = `#version 300 es
precision lowp float;
out vec4 fc;
void main(){ fc=vec4(0); }`;

const DSP_V = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0,1); }`;
const DSP_F = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 fc;
void main(){ fc=texture(u_tex,v_uv); }`;

function compileShader(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const e = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error('Shader: ' + e); }
    return s;
}
function makeProgram(gl, vs, fs, tfVaryings) {
    const v = compileShader(gl, gl.VERTEX_SHADER, vs), f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f);
    if (tfVaryings) gl.transformFeedbackVaryings(p, tfVaryings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { const e = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error('Link: ' + e); }
    gl.deleteShader(v); gl.deleteShader(f); return p;
}

// Instance data: per-segment, no quad duplication
const IFP = 9;       // p1(2) + p2(2) + thick(1) + rgba(4)  — non-TF
const IFP_TF = 7;    // p1(2) + p2(2) + thick(1) + bristleIdx(1) + alpha(1)  — TF
const MAX_INST = 65536;
const MAX_BRISTLES = 512;

// ══════════════════════════════════════════════════════════════════════
//  GLRenderer — instanced rendering
// ══════════════════════════════════════════════════════════════════════

class GLRenderer {
    constructor(logW, logH, useTF) {
        this.logW = logW; this.logH = logH;
        this.w = logW * 2; this.h = logH * 2;
        this.useTF = useTF;
        const c = new OffscreenCanvas(this.w, this.h);
        const gl = c.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
        if (!gl) throw new Error('WebGL2 not available in Worker');
        this.canvas = c; this.gl = gl;

        this.segProg = makeProgram(gl, SEG_V, SEG_F);
        this.dspProg = makeProgram(gl, DSP_V, DSP_F);
        this.uRes = gl.getUniformLocation(this.segProg, 'u_res');
        this.uTex = gl.getUniformLocation(this.dspProg, 'u_tex');
        this.iData = new Float32Array(MAX_INST * IFP);

        if (useTF) {
            this.segTFProg = makeProgram(gl, SEG_TF_V, SEG_F);
            this.uResTF = gl.getUniformLocation(this.segTFProg, 'u_res');
            this.uColorTex = gl.getUniformLocation(this.segTFProg, 'u_colorTex');
            this.tfProg = makeProgram(gl, TF_V, TF_F, ['v_newColor']);
            this.uCanvasTex = gl.getUniformLocation(this.tfProg, 'u_canvasTex');
            this.uCanvasSize = gl.getUniformLocation(this.tfProg, 'u_canvasSize');
            this.uMixStr = gl.getUniformLocation(this.tfProg, 'u_mixStr');
            this.uBgColor = gl.getUniformLocation(this.tfProg, 'u_bgColor');
            this.iDataTF = new Float32Array(MAX_INST * IFP_TF);
            this._initTF();
            this._initSegTF();
        }

        this._initSeg(); this._initDsp(); this._initFBO();
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this._tmpCol = new Float32Array(MAX_BRISTLES * 3);
        this._tmpPos = new Float32Array(MAX_BRISTLES * 2);
    }

    // Non-TF segment VAO (instanced)
    _initSeg() {
        const gl = this.gl, prog = this.segProg;
        this.segVAO = gl.createVertexArray(); gl.bindVertexArray(this.segVAO);
        this.segIBO = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.segIBO);
        gl.bufferData(gl.ARRAY_BUFFER, this.iData.byteLength, gl.DYNAMIC_DRAW);
        const s = IFP * 4;
        const aP1 = gl.getAttribLocation(prog, 'a_p1');
        const aP2 = gl.getAttribLocation(prog, 'a_p2');
        const aT  = gl.getAttribLocation(prog, 'a_thick');
        const aC  = gl.getAttribLocation(prog, 'a_color');
        gl.enableVertexAttribArray(aP1); gl.vertexAttribPointer(aP1, 2, gl.FLOAT, false, s, 0);  gl.vertexAttribDivisor(aP1, 1);
        gl.enableVertexAttribArray(aP2); gl.vertexAttribPointer(aP2, 2, gl.FLOAT, false, s, 8);  gl.vertexAttribDivisor(aP2, 1);
        gl.enableVertexAttribArray(aT);  gl.vertexAttribPointer(aT, 1, gl.FLOAT, false, s, 16);  gl.vertexAttribDivisor(aT, 1);
        gl.enableVertexAttribArray(aC);  gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, s, 20);  gl.vertexAttribDivisor(aC, 1);
        gl.bindVertexArray(null);
    }

    // TF segment VAO (instanced)
    _initSegTF() {
        const gl = this.gl, prog = this.segTFProg;
        this.segTFVAO = gl.createVertexArray(); gl.bindVertexArray(this.segTFVAO);
        this.segTFIBO = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.segTFIBO);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_INST * IFP_TF * 4, gl.DYNAMIC_DRAW);
        const s = IFP_TF * 4;
        const aP1 = gl.getAttribLocation(prog, 'a_p1');
        const aP2 = gl.getAttribLocation(prog, 'a_p2');
        const aT  = gl.getAttribLocation(prog, 'a_thick');
        const aBI = gl.getAttribLocation(prog, 'a_bristleIdx');
        const aA  = gl.getAttribLocation(prog, 'a_alpha');
        gl.enableVertexAttribArray(aP1); gl.vertexAttribPointer(aP1, 2, gl.FLOAT, false, s, 0);  gl.vertexAttribDivisor(aP1, 1);
        gl.enableVertexAttribArray(aP2); gl.vertexAttribPointer(aP2, 2, gl.FLOAT, false, s, 8);  gl.vertexAttribDivisor(aP2, 1);
        gl.enableVertexAttribArray(aT);  gl.vertexAttribPointer(aT, 1, gl.FLOAT, false, s, 16);  gl.vertexAttribDivisor(aT, 1);
        gl.enableVertexAttribArray(aBI); gl.vertexAttribPointer(aBI, 1, gl.FLOAT, false, s, 20); gl.vertexAttribDivisor(aBI, 1);
        gl.enableVertexAttribArray(aA);  gl.vertexAttribPointer(aA, 1, gl.FLOAT, false, s, 24);  gl.vertexAttribDivisor(aA, 1);
        gl.bindVertexArray(null);
    }

    _initTF() {
        const gl = this.gl;
        this.tfFeedback = gl.createTransformFeedback();
        this.tfPosVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tfPosVBO);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_BRISTLES * 2 * 4, gl.DYNAMIC_DRAW);
        this.tfColorBufs = [gl.createBuffer(), gl.createBuffer()];
        for (let i = 0; i < 2; i++) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tfColorBufs[i]);
            gl.bufferData(gl.ARRAY_BUFFER, MAX_BRISTLES * 3 * 4, gl.DYNAMIC_DRAW);
        }
        this.tfPing = 0;
        this.tfVAOs = [gl.createVertexArray(), gl.createVertexArray()];
        for (let i = 0; i < 2; i++) {
            gl.bindVertexArray(this.tfVAOs[i]);
            const aSP = gl.getAttribLocation(this.tfProg, 'a_samplePos');
            const aCC = gl.getAttribLocation(this.tfProg, 'a_curColor');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tfPosVBO);
            gl.enableVertexAttribArray(aSP); gl.vertexAttribPointer(aSP, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tfColorBufs[i]);
            gl.enableVertexAttribArray(aCC); gl.vertexAttribPointer(aCC, 3, gl.FLOAT, false, 0, 0);
            gl.bindVertexArray(null);
        }
        this.colorTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, MAX_BRISTLES, 1, 0, gl.RGB, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    _initDsp() {
        const gl = this.gl;
        this.dspVAO = gl.createVertexArray(); gl.bindVertexArray(this.dspVAO);
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1]), gl.STATIC_DRAW);
        const l = gl.getAttribLocation(this.dspProg, 'a_pos');
        gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
    }
    _initFBO() {
        const gl = this.gl;
        this.fboTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    clear(hex) {
        const gl = this.gl; hex = hex.replace('#', '');
        const r = parseInt(hex.slice(0,2),16)/255, g = parseInt(hex.slice(2,4),16)/255, b = parseInt(hex.slice(4,6),16)/255;
        this.bgR = r; this.bgG = g; this.bgB = b;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, this.w, this.h);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    drawBatch(instCount) {
        if (instCount === 0) return;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, this.w, this.h);
        gl.useProgram(this.segProg); gl.uniform2f(this.uRes, this.logW, this.logH);
        gl.bindVertexArray(this.segVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.segIBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.iData, 0, instCount * IFP);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instCount);
        gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    readRegion(x, y, w, h, buf) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    uploadBristleColors(brush, offset) {
        const gl = this.gl, data = this._tmpCol;
        for (let i = 0; i < brush.nBristles; i++) {
            data[i*3] = brush.colR[i]/255; data[i*3+1] = brush.colG[i]/255; data[i*3+2] = brush.colB[i]/255;
        }
        const sub = new Float32Array(data.buffer, 0, brush.nBristles * 3);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tfColorBufs[0]); gl.bufferSubData(gl.ARRAY_BUFFER, offset*3*4, sub);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tfColorBufs[1]); gl.bufferSubData(gl.ARRAY_BUFFER, offset*3*4, sub);
    }
    uploadBristlePositions(brush, offset, logW, physW, physH) {
        const gl = this.gl, data = this._tmpPos;
        for (let i = 0; i < brush.nBristles; i++) {
            const bx = Math.round(brush.bPosX[i]), by = Math.round(brush.bPosY[i]);
            data[i*2] = bx * 2; data[i*2+1] = by * 2;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tfPosVBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, offset*2*4, new Float32Array(data.buffer, 0, brush.nBristles*2));
    }

    runColorUpdate(nBristles, mixStr) {
        const gl = this.gl, src = this.tfPing, dst = 1 - src;
        gl.useProgram(this.tfProg);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.uniform1i(this.uCanvasTex, 0);
        gl.uniform2f(this.uCanvasSize, this.w, this.h);
        gl.uniform1f(this.uMixStr, mixStr);
        gl.uniform3f(this.uBgColor, this.bgR || 0.94, this.bgG || 0.94, this.bgB || 0.94);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.bindVertexArray(this.tfVAOs[src]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tfFeedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.tfColorBufs[dst]);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, nBristles);
        gl.endTransformFeedback();
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.bindVertexArray(null);
        this.tfPing = dst;
        this._updateColorTex(nBristles);
    }

    _updateColorTex(nBristles) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, this.tfColorBufs[this.tfPing]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nBristles, 1, gl.RGB, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    }

    drawBatchTF(instCount) {
        if (instCount === 0) return;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, this.w, this.h);
        gl.useProgram(this.segTFProg);
        gl.uniform2f(this.uResTF, this.logW, this.logH);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
        gl.uniform1i(this.uColorTex, 1);
        gl.bindVertexArray(this.segTFVAO); gl.bindBuffer(gl.ARRAY_BUFFER, this.segTFIBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.iDataTF, 0, instCount * IFP_TF);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instCount);
        gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    display() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }
    toBitmap() {
        this.display();
        const bmp2x = this.canvas.transferToImageBitmap();
        const out = new OffscreenCanvas(this.logW, this.logH);
        const ctx = out.getContext('2d');
        ctx.drawImage(bmp2x, 0, 0, this.logW, this.logH);
        return out.transferToImageBitmap();
    }
}

// ══════════════════════════════════════════════════════════════════════
//  Render loop
// ══════════════════════════════════════════════════════════════════════

function render(paths, config) {
    const { width, height, brushSize, duration, backgroundColor, pathColors, simultaneous, svgType } = config;
    const mixMode = config.mixMode || 'readpixels';
    const useTF = mixMode === 'gpu';
    const DRAW_EVERY = config.pointStep || 1;
    const cfgMixStr = config.mixStrength;

    // Apply configurable constants
    JOINTS = config.chainJoints || 4;
    SEGS_PER_BRISTLE = JOINTS - 1;
    MAX_BRISTLE_COUNT = config.maxBristles || 120;

    // Apply path noise and rotation for animation frames
    if (config.noiseSeed != null && config.noiseAmplitude > 0) {
        paths = applyPathNoise(paths, config.noiseSeed, config.noiseAmplitude);
    }
    if (config.rotationAngle) {
        paths = rotatePaths(paths, config.rotationAngle);
    }

    // Decimate paths but interpolate between kept points for smooth movement
    const origLengths = paths.map(p => p.length);
    if (DRAW_EVERY > 1) {
        paths = paths.map(pts => {
            if (pts.length < 3) return pts;
            const out = [];
            for (let i = 0; i < pts.length; i += DRAW_EVERY) out.push(pts[i]);
            if ((pts.length - 1) % DRAW_EVERY !== 0) out.push(pts[pts.length - 1]);
            return out;
        });
    }

    const gl = new GLRenderer(width, height, useTF);
    gl.clear(backgroundColor);

    const WARMUP = Math.max(2, Math.ceil(5 / DRAW_EVERY));
    const READ_EVERY = config.readEvery || 20;
    const physW = width * 2, physH = height * 2;
    let totalDone = 0;
    const totalSteps = simultaneous
        ? Math.max(...paths.map(p => p.length))
        : paths.reduce((s, p) => s + p.length, 0);

    const doMix = mixMode === 'readpixels';

    if (useTF) {
        const TF_EVERY = Math.max(1, Math.round(READ_EVERY / DRAW_EVERY));

        if (simultaneous) {
            const brushes = paths.map((pts, i) => {
                const b = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: TF_EVERY, mixStrength: cfgMixStr });
                if (pts.length) b.init(pts[0], pathColors[i] || '#000000');
                return b;
            });
            let bristleOff = 0;
            const offsets = [];
            for (let idx = 0; idx < brushes.length; idx++) {
                offsets.push(bristleOff);
                gl.uploadBristleColors(brushes[idx], bristleOff);
                bristleOff += brushes[idx].nBristles;
            }
            const totalBristles = bristleOff;
            const maxLen = Math.max(...paths.map(p => p.length));
            for (let step = 0; step < maxLen; step++) {
                gl.clear(backgroundColor);
                const prog = step / (maxLen - 1), alpha = Math.max(255 - prog * 205, 50);
                const shouldTF = (step % TF_EVERY === 0);
                for (let idx = 0; idx < paths.length; idx++) {
                    const pts = paths[idx]; if (step >= pts.length) continue;
                    brushes[idx].update(pts[step], alpha, pts[Math.min(step+1, pts.length-1)]);
                    if (shouldTF) gl.uploadBristlePositions(brushes[idx], offsets[idx], width, physW, physH);
                }
                if (shouldTF) {
                    const mixStr = brushes[0].mixStr * (1 + (brushes[0].speed / brushes[0].maxSpeed) * 0.5);
                    gl.runColorUpdate(totalBristles, mixStr);
                }
                let off = 0, inst = 0;
                const vBuf = gl.iDataTF;
                for (let idx = 0; idx < paths.length; idx++) {
                    if (step >= paths[idx].length) continue;
                    const newOff = brushes[idx].writeInstancesTF(vBuf, off, alpha, offsets[idx]);
                    inst += (newOff - off) / IFP_TF;
                    off = newOff;
                }
                if (inst > 0) gl.drawBatchTF(inst);
                totalDone++;
                if (step % 500 === 0) self.postMessage({ type: 'progress', value: totalDone / totalSteps });
            }
        } else {
            for (let pi = 0; pi < paths.length; pi++) {
                const pts = paths[pi]; if (!pts || pts.length < 2) continue;
                const brush = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: TF_EVERY, mixStrength: cfgMixStr });
                brush.init(pts[0], pathColors[pi] || '#000000');
                gl.uploadBristleColors(brush, 0);
                const vBuf = gl.iDataTF;
                let off = 0, inst = 0;
                const FLUSH = MAX_INST - 1000;
                for (let i = 0; i < pts.length; i++) {
                    const shouldTF = (i % TF_EVERY === 0);
                    if (shouldTF && inst > 0) {
                        gl.drawBatchTF(inst); off = 0; inst = 0;
                    }
                    const pathProg = i / (pts.length - 1), alpha = Math.max(255 - pathProg * 205, 50);
                    brush.update(pts[i], alpha, pts[Math.min(i+1, pts.length-1)]);
                    if (shouldTF && alpha >= brush.minAlpha) {
                        gl.uploadBristlePositions(brush, 0, width, physW, physH);
                        const mixStr = brush.mixStr * (1 + (brush.speed / brush.maxSpeed) * 0.5);
                        gl.runColorUpdate(brush.nBristles, mixStr);
                    }
                    if (i >= WARMUP) {
                        const newOff = brush.writeInstancesTF(vBuf, off, alpha, 0);
                        inst += (newOff - off) / IFP_TF;
                        off = newOff;
                        if (inst > FLUSH) { gl.drawBatchTF(inst); off = 0; inst = 0; }
                    }
                    totalDone++;
                    if (i % 500 === 0) self.postMessage({ type: 'progress', value: totalDone / totalSteps });
                }
                if (inst > 0) gl.drawBatchTF(inst);
            }
        }
    } else {
        const vBuf = gl.iData;
        const FLUSH_LIMIT = MAX_INST - 1000;
        const SCALED_READ = Math.max(1, Math.round(READ_EVERY / DRAW_EVERY));

        if (simultaneous) {
            const brushes = paths.map((pts, i) => { const b = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: Math.max(1, Math.round(READ_EVERY / DRAW_EVERY)), mixStrength: cfgMixStr }); if (pts.length) b.init(pts[0], pathColors[i] || '#000000'); return b; });
            const maxLen = Math.max(...paths.map(p => p.length));
            for (let step = 0; step < maxLen; step++) {
                gl.clear(backgroundColor);
                const prog = step / (maxLen - 1), alpha = Math.max(255 - prog * 205, 50);
                const shouldRead = doMix && (step % SCALED_READ === 0);
                let off = 0, inst = 0;
                for (let idx = 0; idx < paths.length; idx++) {
                    const pts = paths[idx]; if (step >= pts.length) continue;
                    brushes[idx].update(pts[step], alpha, pts[Math.min(step+1, pts.length-1)]);
                    if (shouldRead && alpha >= brushes[idx].minAlpha) {
                        const region = brushes[idx].getReadRegion(width, physW, physH);
                        if (region) {
                            const needed = region.rw * region.rh * 4;
                            if (needed > brushes[idx]._regionBuf.length) brushes[idx]._regionBuf = new Uint8Array(needed);
                            gl.readRegion(region.minCol, region.fboY, region.rw, region.rh, brushes[idx]._regionBuf);
                            brushes[idx].applyMix(brushes[idx]._regionBuf, region);
                        }
                    }
                    const newOff = brushes[idx].writeInstances(vBuf, off, alpha);
                    inst += (newOff - off) / IFP;
                    off = newOff;
                }
                if (inst > 0) gl.drawBatch(inst);
                totalDone++;
                if (step % 500 === 0) self.postMessage({ type: 'progress', value: totalDone / totalSteps });
            }
        } else {
            for (let pi = 0; pi < paths.length; pi++) {
                const pts = paths[pi]; if (!pts || pts.length < 2) continue;
                const brush = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: Math.max(1, Math.round(READ_EVERY / DRAW_EVERY)), mixStrength: cfgMixStr });
                brush.init(pts[0], pathColors[pi] || '#000000');
                let off = 0, inst = 0;
                for (let i = 0; i < pts.length; i++) {
                    const shouldRead = doMix && (i % SCALED_READ === 0);
                    if (shouldRead && inst > 0) { gl.drawBatch(inst); off = 0; inst = 0; }
                    const pathProg = i / (pts.length - 1), alpha = Math.max(255 - pathProg * 205, 50);
                    brush.update(pts[i], alpha, pts[Math.min(i+1, pts.length-1)]);
                    if (shouldRead && alpha >= brush.minAlpha) {
                        const region = brush.getReadRegion(width, physW, physH);
                        if (region) {
                            const needed = region.rw * region.rh * 4;
                            if (needed > brush._regionBuf.length) brush._regionBuf = new Uint8Array(needed);
                            gl.readRegion(region.minCol, region.fboY, region.rw, region.rh, brush._regionBuf);
                            brush.applyMix(brush._regionBuf, region);
                        }
                    }
                    if (i >= WARMUP) {
                        const newOff = brush.writeInstances(vBuf, off, alpha);
                        inst += (newOff - off) / IFP;
                        off = newOff;
                        if (inst > FLUSH_LIMIT) { gl.drawBatch(inst); off = 0; inst = 0; }
                    }
                    totalDone++;
                    if (i % 500 === 0) self.postMessage({ type: 'progress', value: totalDone / totalSteps });
                }
                if (inst > 0) { gl.drawBatch(inst); }
            }
        }
    }

    const bitmap = gl.toBitmap();
    self.postMessage({ type: 'complete', bitmap }, [bitmap]);
}

// ══════════════════════════════════════════════════════════════════════
//  Worker message handler
// ══════════════════════════════════════════════════════════════════════

self.onmessage = (e) => {
    try {
        const { pathPointsArray, allFramePaths, allFrameColors, config } = e.data;

        if (allFramePaths && allFramePaths.length > 1) {
            const bitmaps = [];
            for (let fi = 0; fi < allFramePaths.length; fi++) {
                const frameConfig = { ...config };
                if (allFrameColors && allFrameColors[fi]) {
                    frameConfig.pathColors = allFrameColors[fi];
                }
                renderFrame(allFramePaths[fi], frameConfig, (progress) => {
                    const overall = (fi + progress) / allFramePaths.length;
                    self.postMessage({ type: 'progress', value: overall });
                }, (bitmap) => {
                    bitmaps.push(bitmap);
                });
            }
            self.postMessage({ type: 'frames', bitmaps }, bitmaps.map(b => b));
        } else if (allFramePaths && allFramePaths.length === 1) {
            render(allFramePaths[0], config);
        } else if (pathPointsArray) {
            render(pathPointsArray, config);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};

function renderFrame(paths, config, onProgress, onBitmap) {
    const { width, height, brushSize, duration, backgroundColor, pathColors, simultaneous, svgType } = config;
    const mixMode = config.mixMode || 'readpixels';
    const useTF = mixMode === 'gpu';
    const DRAW_EVERY = config.pointStep || 1;
    const cfgMixStr = config.mixStrength;

    JOINTS = config.chainJoints || 4;
    SEGS_PER_BRISTLE = JOINTS - 1;
    MAX_BRISTLE_COUNT = config.maxBristles || 120;

    if (config.noiseSeed != null && config.noiseAmplitude > 0) {
        paths = applyPathNoise(paths, config.noiseSeed, config.noiseAmplitude);
    }
    if (config.rotationAngle) {
        paths = rotatePaths(paths, config.rotationAngle);
    }

    const origLengths = paths.map(p => p.length);
    if (DRAW_EVERY > 1) {
        paths = paths.map(pts => {
            if (pts.length < 3) return pts;
            const out = [];
            for (let i = 0; i < pts.length; i += DRAW_EVERY) out.push(pts[i]);
            if ((pts.length - 1) % DRAW_EVERY !== 0) out.push(pts[pts.length - 1]);
            return out;
        });
    }

    const gl = new GLRenderer(width, height, useTF);
    gl.clear(backgroundColor);

    const WARMUP = Math.max(2, Math.ceil(5 / DRAW_EVERY));
    const READ_EVERY = config.readEvery || 20;
    const physW = width * 2, physH = height * 2;
    let totalDone = 0;
    const totalSteps = simultaneous
        ? Math.max(...paths.map(p => p.length))
        : paths.reduce((s, p) => s + p.length, 0);

    const doMix = mixMode === 'readpixels';

    if (useTF) {
        const TF_EVERY = Math.max(1, Math.round(READ_EVERY / DRAW_EVERY));

        if (simultaneous) {
            const brushes = paths.map((pts, i) => {
                const b = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: TF_EVERY, mixStrength: cfgMixStr });
                if (pts.length) b.init(pts[0], pathColors[i] || '#000000');
                return b;
            });
            let bristleOff = 0;
            const offsets = [];
            for (let idx = 0; idx < brushes.length; idx++) {
                offsets.push(bristleOff);
                gl.uploadBristleColors(brushes[idx], bristleOff);
                bristleOff += brushes[idx].nBristles;
            }
            const totalBristles = bristleOff;
            const maxLen = Math.max(...paths.map(p => p.length));
            for (let step = 0; step < maxLen; step++) {
                gl.clear(backgroundColor);
                const prog = step / (maxLen - 1), alpha = Math.max(255 - prog * 205, 50);
                const shouldTF = (step % TF_EVERY === 0);
                for (let idx = 0; idx < paths.length; idx++) {
                    const pts = paths[idx]; if (step >= pts.length) continue;
                    brushes[idx].update(pts[step], alpha, pts[Math.min(step+1, pts.length-1)]);
                    if (shouldTF) gl.uploadBristlePositions(brushes[idx], offsets[idx], width, physW, physH);
                }
                if (shouldTF) {
                    const mixStr = brushes[0].mixStr * (1 + (brushes[0].speed / brushes[0].maxSpeed) * 0.5);
                    gl.runColorUpdate(totalBristles, mixStr);
                }
                let off = 0, inst = 0;
                const vBuf = gl.iDataTF;
                for (let idx = 0; idx < paths.length; idx++) {
                    if (step >= paths[idx].length) continue;
                    const newOff = brushes[idx].writeInstancesTF(vBuf, off, alpha, offsets[idx]);
                    inst += (newOff - off) / IFP_TF;
                    off = newOff;
                }
                if (inst > 0) gl.drawBatchTF(inst);
                totalDone++;
                if (step % 500 === 0) onProgress(totalDone / totalSteps);
            }
        } else {
            for (let pi = 0; pi < paths.length; pi++) {
                const pts = paths[pi]; if (!pts || pts.length < 2) continue;
                const brush = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: TF_EVERY, mixStrength: cfgMixStr });
                brush.init(pts[0], pathColors[pi] || '#000000');
                gl.uploadBristleColors(brush, 0);
                const vBuf = gl.iDataTF;
                let off = 0, inst = 0;
                const FLUSH = MAX_INST - 1000;
                for (let i = 0; i < pts.length; i++) {
                    const shouldTF = (i % TF_EVERY === 0);
                    if (shouldTF && inst > 0) {
                        gl.drawBatchTF(inst); off = 0; inst = 0;
                    }
                    const pathProg = i / (pts.length - 1), alpha = Math.max(255 - pathProg * 205, 50);
                    brush.update(pts[i], alpha, pts[Math.min(i+1, pts.length-1)]);
                    if (shouldTF && alpha >= brush.minAlpha) {
                        gl.uploadBristlePositions(brush, 0, width, physW, physH);
                        const mixStr = brush.mixStr * (1 + (brush.speed / brush.maxSpeed) * 0.5);
                        gl.runColorUpdate(brush.nBristles, mixStr);
                    }
                    if (i >= WARMUP) {
                        const newOff = brush.writeInstancesTF(vBuf, off, alpha, 0);
                        inst += (newOff - off) / IFP_TF;
                        off = newOff;
                        if (inst > FLUSH) { gl.drawBatchTF(inst); off = 0; inst = 0; }
                    }
                    totalDone++;
                    if (i % 500 === 0) onProgress(totalDone / totalSteps);
                }
                if (inst > 0) gl.drawBatchTF(inst);
            }
        }
    } else {
        const vBuf = gl.iData;
        const FLUSH_LIMIT = MAX_INST - 1000;
        const SCALED_READ = Math.max(1, Math.round(READ_EVERY / DRAW_EVERY));

        if (simultaneous) {
            const brushes = paths.map((pts, i) => { const b = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: SCALED_READ, mixStrength: cfgMixStr }); if (pts.length) b.init(pts[0], pathColors[i] || '#000000'); return b; });
            const maxLen = Math.max(...paths.map(p => p.length));
            for (let step = 0; step < maxLen; step++) {
                gl.clear(backgroundColor);
                const prog = step / (maxLen - 1), alpha = Math.max(255 - prog * 205, 50);
                const shouldRead = doMix && (step % SCALED_READ === 0);
                let off = 0, inst = 0;
                for (let idx = 0; idx < paths.length; idx++) {
                    const pts = paths[idx]; if (step >= pts.length) continue;
                    brushes[idx].update(pts[step], alpha, pts[Math.min(step+1, pts.length-1)]);
                    if (shouldRead && alpha >= brushes[idx].minAlpha) {
                        const region = brushes[idx].getReadRegion(width, physW, physH);
                        if (region) {
                            const needed = region.rw * region.rh * 4;
                            if (needed > brushes[idx]._regionBuf.length) brushes[idx]._regionBuf = new Uint8Array(needed);
                            gl.readRegion(region.minCol, region.fboY, region.rw, region.rh, brushes[idx]._regionBuf);
                            brushes[idx].applyMix(brushes[idx]._regionBuf, region);
                        }
                    }
                    const newOff = brushes[idx].writeInstances(vBuf, off, alpha);
                    inst += (newOff - off) / IFP;
                    off = newOff;
                }
                if (inst > 0) gl.drawBatch(inst);
                totalDone++;
                if (step % 500 === 0) onProgress(totalDone / totalSteps);
            }
        } else {
            for (let pi = 0; pi < paths.length; pi++) {
                const pts = paths[pi]; if (!pts || pts.length < 2) continue;
                const brush = new Brush(brushSize, duration, { svgType, numPaths: paths.length, pointsPerPath: pts.length, readEvery: SCALED_READ, mixStrength: cfgMixStr });
                brush.init(pts[0], pathColors[pi] || '#000000');
                let off = 0, inst = 0;
                for (let i = 0; i < pts.length; i++) {
                    const shouldRead = doMix && (i % SCALED_READ === 0);
                    if (shouldRead && inst > 0) { gl.drawBatch(inst); off = 0; inst = 0; }
                    const pathProg = i / (pts.length - 1), alpha = Math.max(255 - pathProg * 205, 50);
                    brush.update(pts[i], alpha, pts[Math.min(i+1, pts.length-1)]);
                    if (shouldRead && alpha >= brush.minAlpha) {
                        const region = brush.getReadRegion(width, physW, physH);
                        if (region) {
                            const needed = region.rw * region.rh * 4;
                            if (needed > brush._regionBuf.length) brush._regionBuf = new Uint8Array(needed);
                            gl.readRegion(region.minCol, region.fboY, region.rw, region.rh, brush._regionBuf);
                            brush.applyMix(brush._regionBuf, region);
                        }
                    }
                    if (i >= WARMUP) {
                        const newOff = brush.writeInstances(vBuf, off, alpha);
                        inst += (newOff - off) / IFP;
                        off = newOff;
                        if (inst > FLUSH_LIMIT) { gl.drawBatch(inst); off = 0; inst = 0; }
                    }
                    totalDone++;
                    if (i % 500 === 0) onProgress(totalDone / totalSteps);
                }
                if (inst > 0) { gl.drawBatch(inst); }
            }
        }
    }

    const bitmap = gl.toBitmap();
    onBitmap(bitmap);
}

import { PerlinNoise, perlin } from "./perlin";
import { rnd, clamp, parseHex } from "./utils";
import type { BrushWebGLRenderer } from "./BrushWebGLRenderer";

// ── Bristle ─────────────────────────────────────────────────────────

class Bristle {
  nPositions: number;
  positions: { x: number; y: number }[];
  lengths: number[];
  thicknesses: number[];

  constructor(nElements: number, thickness: number) {
    this.nPositions = nElements + 1;
    this.positions = [];
    this.lengths = [];
    this.thicknesses = [];
    const dec = thickness / nElements;
    for (let i = 0; i < this.nPositions; i++) {
      this.positions[i] = { x: 0, y: 0 };
      this.lengths[i] = this.nPositions - i;
      this.thicknesses[i] = thickness - (i - 1) * dec;
    }
  }

  setPosition(p: { x: number; y: number }) {
    for (let i = 0; i < this.nPositions; i++) {
      this.positions[i].x = p.x;
      this.positions[i].y = p.y;
    }
  }

  updatePosition(p: { x: number; y: number }) {
    let prev = this.positions[0];
    prev.x = p.x;
    prev.y = p.y;
    for (let i = 1; i < this.nPositions; i++) {
      const pos = this.positions[i];
      const len = this.lengths[i];
      const ang = Math.atan2(prev.y - pos.y, prev.x - pos.x);
      pos.x = prev.x - len * Math.cos(ang);
      pos.y = prev.y - len * Math.sin(ang);
      prev = pos;
    }
  }

  getSegments(color: { r: number; g: number; b: number }, alpha: number) {
    const segs: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      thickness: number;
      r: number;
      g: number;
      b: number;
      a: number;
    }[] = [];
    let prev = this.positions[0];
    for (let i = 1; i < this.nPositions; i++) {
      const pos = this.positions[i];
      segs.push({
        x1: prev.x,
        y1: prev.y,
        x2: pos.x,
        y2: pos.y,
        thickness: this.thicknesses[i],
        r: color.r,
        g: color.g,
        b: color.b,
        a: alpha,
      });
      prev = pos;
    }
    return segs;
  }
}

// ── Brush ───────────────────────────────────────────────────────────

export class Brush {
  maxBristleLength = 15;
  maxBristleThickness = 5;
  bristleVerticalNoise = 8;
  position = { x: 0, y: 0 };
  prevPosition = { x: 0, y: 0 };
  nBristles: number;
  bristles: Bristle[];
  bOffsets: { x: number; y: number }[];
  bPositions: { x: number; y: number }[];
  colors: { r: number; g: number; b: number }[];
  colorChange = 40;
  baseMixStrength: number;
  referenceDuration = 5000;
  mixStrength: number;
  minAlpha = 20;
  currentColor: string | null = null;
  speed = 0;
  maxSpeed = 10;
  lastAngle = 0;

  constructor(size: number, duration: number, config: { svgType?: string }) {
    this.baseMixStrength = config.svgType === "line" ? 0.005 : 0.08;
    this.mixStrength =
      this.baseMixStrength * (this.referenceDuration / duration);
    this.nBristles = Math.round(size * rnd(1.6, 1.9));
    this.bristles = [];
    this.bOffsets = [];
    this.bPositions = [];
    this.colors = [];

    const bLen = Math.min(size, this.maxBristleLength);
    const nElem = Math.round(Math.sqrt(2 * bLen));
    const bThick = Math.min(0.8 * bLen, this.maxBristleThickness);

    for (let i = 0; i < this.nBristles; i++) {
      this.bristles[i] = new Bristle(nElem, bThick);
      this.bOffsets[i] = {
        x: size * rnd(-0.5, 0.5),
        y: this.bristleVerticalNoise * rnd(-0.5, 0.5),
      };
      this.bPositions[i] = { x: 0, y: 0 };
    }
  }

  updateColor(color: string) {
    if (this.currentColor === color) return;
    this.currentColor = color;
    const { r, g, b } = parseHex(color);
    const seed = rnd(1000);
    for (let i = 0; i < this.nBristles; i++) {
      const d = this.colorChange * (perlin.noise(seed + 0.4 * i) - 0.5);
      this.colors[i] = {
        r: clamp(r + d, 0, 255),
        g: clamp(g + d, 0, 255),
        b: clamp(b + d, 0, 255),
      };
    }
  }

  init(pos: { x: number; y: number }, color: string) {
    this.position.x = pos.x;
    this.position.y = pos.y;
    this.prevPosition.x = pos.x;
    this.prevPosition.y = pos.y;
    this._updateBristlePositions(0);
    this.updateColor(color);
    for (let i = 0; i < this.nBristles; i++)
      this.bristles[i].setPosition(this.bPositions[i]);
  }

  update(
    newPos: { x: number; y: number },
    updateElements: boolean,
    alpha: number,
    nextPos: { x: number; y: number } | null,
    renderer?: BrushWebGLRenderer,
    cachedPixels?: Uint8Array
  ) {
    this.prevPosition.x = this.position.x;
    this.prevPosition.y = this.position.y;
    this.position.x = newPos.x;
    this.position.y = newPos.y;

    const dx = this.position.x - this.prevPosition.x;
    const dy = this.position.y - this.prevPosition.y;
    this.speed = Math.min(Math.sqrt(dx * dx + dy * dy), this.maxSpeed);

    let dirAngle = this.lastAngle;
    if (nextPos) {
      const ndx = nextPos.x - newPos.x;
      const ndy = nextPos.y - newPos.y;
      if (Math.abs(ndx) > 0.01 || Math.abs(ndy) > 0.01) {
        dirAngle = Math.atan2(ndy, ndx) + Math.PI / 2;
        this.lastAngle = dirAngle;
      }
    }

    this._updateBristlePositions(
      dirAngle,
      1 + (this.speed / this.maxSpeed) * 0.5
    );

    if (updateElements) {
      for (let i = 0; i < this.nBristles; i++) {
        this.bristles[i].updatePosition(this.bPositions[i]);
      }
    }

    if (alpha >= this.minAlpha && renderer) {
      const pixels = cachedPixels || renderer.readPixels();
      for (let i = 0; i < this.nBristles; i++) {
        const bp = this.bPositions[i];
        const x = Math.round(bp.x);
        const y = Math.round(bp.y);
        if (x >= 0 && x < renderer.width && y >= 0 && y < renderer.height) {
          const c = renderer.getPixelAt(pixels, x, y);
          const sm = 1 + (this.speed / this.maxSpeed) * 0.5;
          const mix = this.mixStrength * sm;
          const f = 1 - mix;
          this.colors[i] = {
            r: f * this.colors[i].r + mix * c.r,
            g: f * this.colors[i].g + mix * c.g,
            b: f * this.colors[i].b + mix * c.b,
          };
        }
      }
    }
  }

  _updateBristlePositions(angle: number, spread = 1) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < this.nBristles; i++) {
      const o = this.bOffsets[i];
      const x = o.x * spread,
        y = o.y * spread;
      this.bPositions[i].x = this.position.x + (x * cos - y * sin);
      this.bPositions[i].y = this.position.y + (x * sin + y * cos);
    }
  }

  collectSegments(alpha: number) {
    const a = alpha / 255;
    const all: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      thickness: number;
      r: number;
      g: number;
      b: number;
      a: number;
    }[] = [];
    for (let i = 0; i < this.nBristles; i++) {
      const segs = this.bristles[i].getSegments(this.colors[i], a);
      for (let j = 0; j < segs.length; j++) all.push(segs[j]);
    }
    return all;
  }
}

// ── Path utilities ──────────────────────────────────────────────────

export const parsePathToPoints = (
  pathData: string,
  numPoints = 200
): { x: number; y: number }[] => {
  try {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    const totalLength = path.getTotalLength();
    const baseCount = Math.ceil(totalLength * 5);
    const count = Math.min(Math.max(numPoints, baseCount), 30000);
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const pt = path.getPointAtLength((i / count) * totalLength);
      points.push({ x: pt.x, y: pt.y });
    }
    return points;
  } catch (e) {
    console.error("Error parsing path:", e);
    return [];
  }
};

export function applyPathNoise(
  paths: { x: number; y: number }[][],
  seed: number,
  amplitude: number,
  noiseGen?: PerlinNoise
) {
  if (!amplitude) return paths;
  const ng = noiseGen || perlin;
  return paths.map((pts, pi) =>
    pts.map((p, i) => {
      const t = i / (pts.length || 1);
      const nx = (ng.noise(seed + pi * 97 + t * 8) - 0.5) * 2 * amplitude;
      const ny =
        (ng.noise(seed + pi * 97 + t * 8 + 500) - 0.5) * 2 * amplitude;
      return { x: p.x + nx, y: p.y + ny };
    })
  );
}

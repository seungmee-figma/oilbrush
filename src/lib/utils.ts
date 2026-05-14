export function rnd(a: number, b?: number): number {
  if (b === undefined) {
    b = a;
    a = 0;
  }
  return a + Math.random() * (b - a);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  hex = hex.replace("#", "");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

export function interpolateColor(c1: string, c2: string, t: number): string {
  const r1 = parseInt(c1.slice(1, 3), 16),
    g1 = parseInt(c1.slice(3, 5), 16),
    b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16),
    g2 = parseInt(c2.slice(3, 5), 16),
    b2 = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t),
    g = Math.round(g1 + (g2 - g1) * t),
    b = Math.round(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

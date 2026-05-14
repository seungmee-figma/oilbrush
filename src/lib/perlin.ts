export class PerlinNoise {
  private SIZE = 4096;
  private table: Float32Array;

  constructor() {
    this.table = new Float32Array(this.SIZE + 1);
    for (let i = 0; i < this.SIZE + 1; i++) this.table[i] = Math.random();
  }

  noise(x: number): number {
    if (x < 0) x = -x;
    let xi = Math.floor(x),
      xf = x - xi,
      r = 0,
      ampl = 0.5;
    for (let o = 0; o < 4; o++) {
      const i = (xi >> 0) & (this.SIZE - 1);
      const rxf = 0.5 * (1.0 - Math.cos(xf * Math.PI));
      r += (this.table[i] + rxf * (this.table[i + 1] - this.table[i])) * ampl;
      ampl *= 0.5;
      xi = Math.floor(x * (1 << (o + 1)));
      xf = x * (1 << (o + 1)) - xi;
    }
    return r;
  }
}

export const perlin = new PerlinNoise();

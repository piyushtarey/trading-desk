// Small numeric/id helpers. (The mulberry32 seeded-PRNG family was removed
// with the seeded history in M2 — live data needs no RNG.)
export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

let counter = 0;
export function uid(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(
    Math.random() * 1e6
  ).toString(36)}`;
}

// Human pacing. Uniform random delays are themselves a fingerprint — humans
// are heavy-tailed. Everything here samples from log-normal-ish distributions:
// mostly quick actions, occasional long dwells, rare "got distracted" idles.

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormalMs(medianMs, sigma = 0.7, { minMs = 800, maxMs = 180000 } = {}) {
  const ms = medianMs * Math.exp(sigma * gauss());
  return Math.min(maxMs, Math.max(minMs, Math.round(ms)));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function planActionGap(pacing) {
  const gap = lognormalMs(pacing.actionGapMedianMs ?? 7000, pacing.sigma ?? 0.7);
  const idleChance = pacing.idleChance ?? 0.05;
  const idle =
    Math.random() < idleChance
      ? lognormalMs(pacing.idleMedianMs ?? 45000, 0.5, {
          minMs: pacing.idleMinMs ?? 20000,
          maxMs: pacing.idleMaxMs ?? 150000,
        })
      : 0;
  return { gap, idle, total: gap + idle };
}

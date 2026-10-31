// Challenge circuit breaker. Any confirmed challenge / login wall / suspicious
// activity screen stops all automation for a cooldown period — the account
// needs quiet, not more traffic.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataFile } from "./log.js";

const breakerFile = () => dataFile("breaker.json");

export function status() {
  const f = breakerFile();
  if (!existsSync(f)) return { open: false };
  try {
    const { until, reason, trippedAt } = JSON.parse(readFileSync(f, "utf8"));
    if (Date.now() < until) return { open: true, until: new Date(until).toISOString(), reason, trippedAt };
  } catch {
    // corrupt file = no breaker
  }
  return { open: false };
}

export function trip(hours, reason) {
  const until = Date.now() + hours * 3_600_000;
  writeFileSync(
    breakerFile(),
    JSON.stringify({ until, reason, trippedAt: new Date().toISOString() }, null, 2)
  );
  return { until: new Date(until).toISOString(), reason };
}

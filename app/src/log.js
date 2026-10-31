// JSONL event log. Everything the harness observes or decides lands here so
// Jev's calibration can be audited later (predicted probability vs outcome).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(
  process.env.INSTAPY_DATA ?? new URL("../data", import.meta.url).pathname
);

export function dataFile(name) {
  mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, name);
}

export function appendEvent(name, event) {
  const record = { ts: new Date().toISOString(), ...event };
  appendFileSync(dataFile(name), JSON.stringify(record) + "\n");
  return record;
}

export function readEvents(name) {
  const file = dataFile(name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

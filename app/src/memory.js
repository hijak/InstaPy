// Relationship memory + quota gates. Deterministic rules decide what the
// models never see: already-interacted posts are removed before Jev is
// consulted, and daily caps are enforced before any browsing starts.
import { appendEvent, readEvents } from "./log.js";

const EVENTS = "events.jsonl";

export function loadState() {
  const events = readEvents(EVENTS);
  const viewed = new Set();
  const liked = new Set();
  for (const e of events) {
    if (e.type === "view" && e.postId) viewed.add(e.postId);
    if (e.type === "engage" && e.decision === "like" && e.result === "liked" && e.postId)
      liked.add(e.postId);
  }
  return { events, viewed, liked };
}

export function todayCounts(events) {
  const today = new Date().toISOString().slice(0, 10);
  let views = 0;
  let likes = 0;
  for (const e of events) {
    if (!e.ts || e.ts.slice(0, 10) !== today) continue;
    if (e.type === "view") views++;
    if (e.type === "engage" && e.decision === "like" && e.result === "liked") likes++;
  }
  return { views, likes };
}

export function quotaLeft(state, config) {
  const { views, likes } = todayCounts(state.events);
  return {
    views: Math.max(0, config.daily.maxViews - views),
    likes: Math.max(0, config.daily.maxLikes - likes),
  };
}

export const record = (event) => appendEvent(EVENTS, event);

#!/usr/bin/env node
// Session runner: one bounded, human-paced browsing session.
//   node bin/session.js                    # live, bounded by config.json
//   node bin/session.js --dry              # browses and decides, never likes
//   node bin/session.js --max-views 2 --max-likes 1 --tag photography
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openHashtag, openPost, likePost, closePost } from "../src/act.js";
import { loadState, quotaLeft, record } from "../src/memory.js";
import { planActionGap, sleep, lognormalMs } from "../src/pacing.js";
import { pickPost, engage } from "../src/decide.js";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(path.join(appDir, "config.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dryRun = args.includes("--dry");
const tag = String(flag("tag", config.hashtags[0])).replace(/[^A-Za-z0-9_]/g, "");
const niche = config.niche;

const state = loadState();
const quota = quotaLeft(state, config);
const viewBudget = Math.min(Number(flag("max-views", config.session.maxViews)), quota.views);
const likeBudget = Math.min(Number(flag("max-likes", config.session.maxLikes)), quota.likes);
const deadline = Date.now() + (config.session.maxDurationMin ?? 15) * 60_000;

console.log(
  `instapy-reborn | #${tag} | budgets: ${viewBudget} views, ${likeBudget} likes${dryRun ? " | DRY RUN (no likes)" : ""}`
);
if (viewBudget === 0) {
  console.log("daily view quota exhausted — not starting");
  process.exit(0);
}

record({ type: "session", event: "start", tag, viewBudget, likeBudget, dry: dryRun });

const seen = new Set([...state.viewed, ...state.liked]);
const grid = openHashtag(tag);
console.log(`grid loaded: ${grid.posts.length} posts in view`);

let views = 0;
let likes = 0;

try {
  while (views < viewBudget && Date.now() < deadline) {
    const { total } = planActionGap(config.pacing);
    await sleep(total);

    const pick = await pickPost(grid.posts, { seen, tag, niche });
    if (!pick.post) {
      console.log("nothing new to view — ending session");
      break;
    }
    seen.add(pick.post);

    let opened;
    try {
      opened = openPost(pick.post);
    } catch (e) {
      record({ type: "error", stage: "open", postId: pick.post, message: String(e.message).slice(0, 300) });
      console.error(`  open failed — trying next candidate`);
      continue;
    }
    const postInfo = { postId: pick.post, author: opened.author, caption: opened.caption };
    record({ type: "view", postId: pick.post, author: opened.author, url: opened.url });
    views++;
    console.log(`viewing ${pick.post} by @${opened.author} (view ${views}/${viewBudget})`);

    await sleep(lognormalMs(config.pacing.dwellMedianMs ?? 9000, config.pacing.sigma ?? 0.7));

    let verdict;
    if (opened.alreadyLiked) {
      // The page is ground truth: memory can miss likes made outside the
      // harness, and re-liking would toggle the like off.
      verdict = { decision: "skip", reason: "already liked (detected on page)" };
    } else if (dryRun) {
      verdict = await engage(postInfo, { config, liked: state.liked, tag, niche });
      verdict = { ...verdict, decision: "skip", reason: "dry run" };
    } else if (likes >= likeBudget) {
      verdict = { decision: "skip", reason: "like budget exhausted" };
    } else {
      verdict = await engage(postInfo, { config, liked: state.liked, tag, niche });
    }

    if (verdict.decision === "like" && !dryRun) {
      const res = likePost();
      if (res.ok) {
        likes++;
        record({ type: "engage", decision: "like", result: "liked", postId: pick.post });
        console.log(`  liked ${pick.post} (verified)`);
      } else {
        // Circuit breaker: a like that fails verification means the screen is
        // not what we think it is. End the whole session immediately.
        record({ type: "challenge_suspected", postId: pick.post, reason: res.reason });
        console.error(`  like verification failed (${res.reason}) — stopping session`);
        closePost();
        break;
      }
    } else {
      record({
        type: "engage",
        decision: "skip",
        result: "skipped",
        postId: pick.post,
        confidence: verdict.confidence,
        spam: verdict.spam,
        escalated: verdict.escalated,
        reason: verdict.reason,
      });
      if (verdict.escalated) console.log(`  skip (low confidence ${verdict.confidence} — escalation guard)`);
      else console.log(`  skip (${verdict.reason ?? "Jev decision"})`);
    }
    closePost();
  }
} finally {
  record({ type: "session", event: "end", views, likes });
  console.log(`session done: ${views} views, ${likes} likes`);
}

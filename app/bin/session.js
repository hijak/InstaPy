#!/usr/bin/env node
// Session runner: one bounded, human-paced browsing session.
//   node bin/session.js                    # live, bounded by config.json
//   node bin/session.js --dry              # browses and decides, never likes
//   node bin/session.js --max-views 2 --max-likes 1 --tag photography
//   node bin/session.js --jitter-minutes 20   # random delayed start (for schedulers)
// Without --tag, hashtags rotate day by day across config.hashtags.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openHashtag, openPost, likePost, closePost, pageBrief } from "../src/act.js";
import { loadState, quotaLeft, record } from "../src/memory.js";
import { planActionGap, sleep, lognormalMs } from "../src/pacing.js";
import { pickPost, engage } from "../src/decide.js";
import { status as breakerStatus, trip as tripBreaker } from "../src/breaker.js";
import { classifyScreen } from "../src/escalate.js";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(path.join(appDir, "config.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dryRun = args.includes("--dry");
const niche = config.niche;

const jitterMin = Number(flag("jitter-minutes", 0));
if (jitterMin > 0) {
  const wait = Math.round(Math.random() * jitterMin * 60_000);
  console.log(`jitter: waiting ${Math.round(wait / 1000)}s before starting`);
  await sleep(wait);
}

const breaker = breakerStatus();
if (breaker.open) {
  console.log(`circuit breaker open until ${breaker.until} (${breaker.reason}) — not starting`);
  process.exit(0);
}

const tagOverride = args.includes("--tag") ? flag("tag", null) : null;
const tag = String(
  tagOverride ?? config.hashtags[Math.floor(Date.now() / 86_400_000) % config.hashtags.length]
).replace(/[^A-Za-z0-9_]/g, "");

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

    let pick;
    try {
      pick = await pickPost(grid.posts, { seen, tag, niche });
    } catch (e) {
      record({ type: "error", stage: "pick", message: String(e.message).slice(0, 300) });
      console.error("decision layer failed — ending session");
      break;
    }
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
      try {
        verdict = await engage(postInfo, { config, liked: state.liked, tag, niche });
      } catch (e) {
        record({ type: "error", stage: "engage", postId: pick.post, message: String(e.message).slice(0, 300) });
        verdict = { decision: "skip", reason: "decision layer error" };
      }
    }

    if (verdict.decision === "like" && !dryRun) {
      const res = likePost();
      if (res.ok) {
        likes++;
        record({ type: "engage", decision: "like", result: "liked", postId: pick.post });
        console.log(`  liked ${pick.post} (verified)`);
      } else {
        // A like that fails verification means the screen is not what we
        // think it is. Classify it before deciding how hard to react.
        record({ type: "engage", decision: "like", result: "failed", postId: pick.post, reason: res.reason });
        let screenVerdict;
        try {
          screenVerdict = await classifyScreen(pageBrief());
        } catch (e) {
          screenVerdict = { screen: "unknown", used: "error" };
        }
        if (screenVerdict.screen === "challenge") {
          const b = tripBreaker(
            config.breaker?.challengeCooldownHours ?? 48,
            `challenge detected after like failure on ${pick.post}`
          );
          record({ type: "challenge_confirmed", postId: pick.post, screen: screenVerdict, breaker: b });
          console.error(`  challenge confirmed (${screenVerdict.used}) — breaker until ${b.until}`);
        } else {
          record({ type: "challenge_suspected", postId: pick.post, screen: screenVerdict });
          console.error(`  unexpected screen (${screenVerdict.screen}, ${screenVerdict.used}) — ending session`);
        }
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
        escalationUsed: verdict.escalationUsed,
        reason: verdict.reason,
      });
      const bits = [verdict.reason ?? "Jev decision"];
      if (verdict.escalated) bits.push(`escalated via ${verdict.escalationUsed ?? "n/a"}`);
      console.log(`  skip (${bits.join("; ")})`);
    }
    closePost();
  }
} finally {
  record({ type: "session", event: "end", views, likes });
  console.log(`session done: ${views} views, ${likes} likes`);
}

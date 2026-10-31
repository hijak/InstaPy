// Escalation layer: the jobs Jev can't safely do alone.
//   1. engage escalation — a borderline Jev "like" gets a second opinion
//   2. screen triage — after an unexpected screen, decide whether it is a
//      Meta challenge (→ circuit breaker) or something benign
// Rule fast-paths run first so the LLM is only asked when it adds information.
import { isConfigured, askJSON } from "./llm.js";
import { record } from "./memory.js";

const ENGAGE_SYSTEM =
  "You are the escalation decision layer of a cautious Instagram browsing assistant acting as the account owner. Decide whether to like a post. Rules: like only content that plausibly matches genuine interest in the account's niche; skipping is normal and frequent for a human; never like engagement-bait, feature-farm, or off-niche spam.";

export async function escalateEngage(postInfo, jev, ctx) {
  if (!isConfigured()) return { used: "unavailable", decision: "skip" };
  try {
    const verdict = await askJSON(
      ENGAGE_SYSTEM,
      `Account niche: ${ctx.niche}. The post is from the #${ctx.tag} grid. Author: @${postInfo.author ?? "unknown"}. Caption: ${JSON.stringify(postInfo.caption ?? "")}. The fast decision layer leaned "${jev.choice}" with confidence ${jev.confidence} and spam probability ${jev.spam}. Escalate: like or skip?`,
      { maxTokens: 800 }
    );
    const decision = verdict.decision === "like" ? "like" : "skip";
    record({
      type: "escalation",
      stage: "engage",
      postId: postInfo.postId,
      decision,
      reason: verdict.reason,
    });
    return { used: "llm", decision, reason: verdict.reason };
  } catch (e) {
    record({ type: "escalation", stage: "engage", error: String(e.message).slice(0, 200) });
    return { used: "error", decision: "skip", reason: String(e.message).slice(0, 100) };
  }
}

const TRIAGE_SYSTEM =
  'You classify Instagram screen states for a browsing assistant. Classify the described page into exactly one of: "post" (normal content view), "challenge" (Meta verification: login wall, checkpoint, suspicious-activity or identity confirmation screens), "unknown". Respond as JSON: {"screen":"post"|"challenge"|"unknown","safe_to_act":true|false,"reason":"<short>"}';

export async function classifyScreen(brief) {
  // Rule fast-paths — no model needed for the obvious cases.
  if (
    brief.hasLoginForm ||
    /accounts\/login|challenge|checkpoint|suspended|locked/i.test(brief.url)
  ) {
    return { screen: "challenge", safeToAct: false, used: "rules" };
  }

  if (!isConfigured()) return { screen: "unknown", safeToAct: false, used: "unavailable" };
  try {
    const verdict = await askJSON(
      TRIAGE_SYSTEM,
      `URL: ${brief.url}\nTitle: ${brief.title}\nHas open dialog: ${brief.hasDialog}\nVisible text (truncated): ${JSON.stringify(brief.textSample)}`,
      { maxTokens: 800 }
    );
    const screen = ["post", "challenge", "unknown"].includes(verdict.screen)
      ? verdict.screen
      : "unknown";
    record({ type: "escalation", stage: "triage", screen, reason: verdict.reason });
    return { screen, safeToAct: screen === "post" && verdict.safe_to_act !== false, used: "llm" };
  } catch (e) {
    record({ type: "escalation", stage: "triage", error: String(e.message).slice(0, 200) });
    return { screen: "unknown", safeToAct: false, used: "error" };
  }
}

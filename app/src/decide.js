// Decision layer: rules first, Jev for what rules can't judge, LLM escalation
// for borderline calls. Jev never sees posts the memory gate removed; a
// low-confidence "like" goes to the LLM for a second opinion when one is
// configured, and degrades to "skip" (safe default) when none is.
import { ask, choiceAnswer, noulAnswer } from "./jev.js";
import { escalateEngage } from "./escalate.js";
import { record } from "./memory.js";

export async function pickPost(posts, ctx) {
  const candidates = posts.filter((p) => !ctx.seen.has(p)).slice(0, 8);
  if (candidates.length === 0) return { post: null, reason: "no unseen candidates" };

  const criteria = Object.fromEntries(
    candidates.map((p, i) => [p, `candidate ${i + 1}, in grid order`])
  );
  const resp = await ask(
    `An Instagram browsing assistant operating a personal ${ctx.niche}-interest account is on the #${ctx.tag} hashtag grid, seconds after arriving. A memory gate already removed posts the account interacted with previously, so the list may start mid-grid. Candidates are listed in grid order. Choose one post to open for genuine viewing; humans scan unevenly and do not systematically prefer the first option.`,
    {
      pick_post: {
        type: "choice",
        instructions: "Choose which post to open next for genuine viewing.",
        criteria,
      },
    }
  );
  const ans = choiceAnswer(resp, "pick_post");
  record({ type: "decision", decision: "pick_post", choice: ans.choice, confidence: ans.confidence });
  return { post: ans.choice, confidence: ans.confidence };
}

export async function engage(postInfo, ctx) {
  if (ctx.liked.has(postInfo.postId)) {
    return { decision: "skip", reason: "already liked previously (memory gate)" };
  }

  const resp = await ask(
    `An Instagram browsing assistant operating a personal ${ctx.niche}-interest account has opened a post from the #${ctx.tag} grid. Author: @${postInfo.author ?? "unknown"}. Caption: ${JSON.stringify(postInfo.caption ?? "")}. The account interacts sparingly and values genuine content.`,
    {
      engage: {
        type: "choice",
        instructions:
          "Decide as a discerning human owner of this account. Like only content that plausibly matches genuine interest in the niche; skipping is normal and frequent for a human.",
        criteria: { like: "like this post before moving on", skip: "move on without engaging" },
      },
      spam: {
        type: "noul",
        instructions:
          "Probability that this post is engagement-bait, feature-farm, or spam rather than genuine original content.",
      },
    }
  );
  const ans = choiceAnswer(resp, "engage");
  const spam = noulAnswer(resp, "spam").noul;

  let decision = ans.choice;
  let escalation = null;
  if (decision === "like" && (ans.confidence ?? 0) < ctx.config.jev.escalateBelowConfidence) {
    escalation = await escalateEngage(postInfo, { choice: ans.choice, confidence: ans.confidence, spam }, ctx);
    decision = escalation.decision;
  }

  record({
    type: "decision",
    decision: "engage",
    choice: ans.choice,
    confidence: ans.confidence,
    spam,
    escalated: !!escalation,
    escalationUsed: escalation?.used,
    escalationReason: escalation?.reason,
    finalDecision: decision,
    postId: postInfo.postId,
  });
  return {
    decision,
    confidence: ans.confidence,
    spam,
    escalated: !!escalation,
    escalationUsed: escalation?.used,
    escalationReason: escalation?.reason,
  };
}

# InstaPy Reborn

A from-scratch successor to the original InstaPy, built on the architecture that
the old Selenium/XPath approach could never have: instead of brittle selectors,
a **real browser session** (ego lite, running the user's own logged-in profile)
is driven through a **decision layer** — deterministic rules first, then Jev
(System One decisions with calibrated probabilities), with an LLM escalation
path for screens no rule or decision covers.

## Architecture

```
bin/session.js     one bounded, human-paced browsing session
src/act.js         ego-browser execution (open grid/post, like, verify, close)
src/decide.js      rules → Jev → (later) LLM escalation
src/jev.js         Jev System One client (api.typesafe.ai)
src/pacing.js      log-normal dwell/action delays, rare long idles
src/memory.js      relationship memory + daily quota gates (JSONL)
src/log.js         JSONL event log (audit Jev calibration over time)
```

Design invariants:

1. **Rules gate what models see.** Already-viewed/liked posts never reach Jev;
   daily caps are checked before browsing starts.
2. **Jev picks from typed choices, never generates strings.** A low-confidence
   "like" degrades to "skip" (safe default) until the LLM escalation hook is live.
3. **Every like is verified.** The action button's label must flip Like →
   Unlike; a failed verification trips a circuit breaker that ends the session.
4. **Human pacing is distributional, not uniform.** Log-normal dwell times,
   occasional 20–150s idles, view-many/act-few asymmetry.

## Usage

Prereqs: [ego lite](https://github.com/InstaPy/InstaPy#readme) installed and
logged into Instagram, Node ≥ 18, a Jev API key at `~/.config/typesafe/key`
(or `TYPESAFE_API_KEY`).

```bash
cd app
node bin/session.js --dry              # browse + decide, never like
node bin/session.js                    # live, bounded by config.json
node bin/session.js --max-views 2 --max-likes 1 --tag photography
```

All events land in `app/data/events.jsonl` (gitignored). Daily quotas count
today's events; the session exits early once caps are hit.

## Status / roadmap

- [x] MVP loop: grid → Jev pick → open → dwell → Jev like/skip → verify → log
- [ ] LLM escalation on low confidence and unknown screens
- [ ] Challenge screen detection (device verification etc.) → 48h circuit breaker
- [ ] Session scheduler (launchd) + multi-hashtag rotation
- [ ] Local-runner SaaS control plane (see repo discussion)

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

## LLM credentials (escalation layer)

The escalation layer (borderline engage calls, screen triage) works with API
keys or OAuth. Resolution order: `~/.config/instapy/llm.json` →
`app/llm.local.json` (gitignored) → environment variables
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` — provider inferred).
Supported auth modes:

- **api-key** — env var, inline, or file config (see `llm.example.json`)
- **oauth-adc** — Google Application Default Credentials: real OAuth with
  automatic token refresh, no API key (`gcloud auth application-default login`)
- **oauth-token** — static bearer token from a JSON file (e.g. an Anthropic
  OAuth access token)
- **none** — local keyless runtimes (Ollama, LM Studio) over the
  OpenAI-compatible surface

Verify with `node bin/llm-check.js`. Without an LLM configured the harness
still runs — escalations degrade to the safe default (skip).

## Scheduling (launchd)

`scripts/install-launchd.sh` installs — but does not load — a LaunchAgent that
runs two bounded sessions a day (10:07 and 19:23, with up to 20 minutes of
start jitter so the schedule isn't metronomic). Hashtags rotate daily across
`config.hashtags`; the daily caps in the same file always bound total activity.
Load it with `launchctl load ~/Library/LaunchAgents/com.instapy.reborn.session.plist`
when you're ready for unattended runs.

## Status / roadmap

- [x] MVP loop: grid → Jev pick → open → dwell → Jev like/skip → verify → log
- [x] LLM escalation on low confidence and unexpected screens (api-key + OAuth creds)
- [x] Challenge triage + 48h circuit breaker (rule fast-paths + LLM classification)
- [x] launchd scheduler + hashtag rotation + start jitter
- [ ] Calibration report from accumulated JSONL (Jev p vs outcome)
- [ ] Local-runner SaaS control plane (see repo discussion)

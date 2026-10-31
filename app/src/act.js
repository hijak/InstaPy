// ego-browser execution layer.
// Every action spawns `ego-browser nodejs`; task spaces persist across
// processes, so the page keeps its URL and the login session between calls.
// Each script must print a final RESULT: line for machine parsing.
// DOM checks target the aria-label on the SVG inside Instagram's action
// buttons (the button element itself has no label).
import { spawnSync } from "node:child_process";

const SPACE = process.env.INSTAPY_SPACE ?? "instapy-reborn";
const TIMEOUT_MS = 90_000;

function run(script) {
  // Feed the script on stdin — the same path as `ego-browser nodejs <<EOF`,
  // which is the documented and reliable invocation.
  const res = spawnSync("ego-browser", ["nodejs"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    input: script,
  });
  if (res.error) throw new Error(`ego-browser failed to run: ${res.error.message}`);
  const out = res.stdout ?? "";
  if (res.status !== 0) {
    throw new Error(`ego-browser exited ${res.status}: ${(res.stderr || out).slice(-500)}`);
  }
  // ego routes console.log from the embedded runtime to stderr, so scan both.
  const line = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
    .split("\n")
    .find((l) => l.startsWith("RESULT:"));
  if (!line) {
    throw new Error(`no RESULT in ego output. stdout: ${(res.stdout ?? "").slice(-400)} stderr: ${(res.stderr ?? "").slice(-400)}`);
  }
  return JSON.parse(line.slice("RESULT:".length));
}

const ENSURE = `const task = await taskSpace(${JSON.stringify(SPACE)});
const page = task.page("p1");`;

export function openHashtag(tag, { limit = 9 } = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(tag)) throw new Error(`invalid hashtag: ${tag}`);
  return run(`${ENSURE}
await page.goto("https://www.instagram.com/explore/tags/${tag}/");
await page.waitForLoadState();
await page.waitForTimeout(2500);
const posts = await page.evaluate((limit) => {
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href^="/p/"]')) {
    const id = a.getAttribute("href").split("/")[2];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    if (out.length >= limit) break;
  }
  return out;
}, ${limit});
console.log("RESULT:" + JSON.stringify({ url: await page.url(), posts }));
`);
}

export function openPost(postId) {
  if (!/^[A-Za-z0-9_-]+$/.test(postId)) throw new Error(`invalid post id: ${postId}`);
  return run(`${ENSURE}
// A pointer left over the grid keeps a hover-card dialog alive, which
// intercepts the click. Dismiss it and park the pointer before clicking.
await page.keyboard.press("Escape");
await page.mouse.move(8, 200, { label: "park pointer off the grid" });
await page.waitForTimeout(600);
await page.click("loc=href:/p/${postId}/", { label: "open post" });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const dlg = document.querySelector('div[role="dialog"]') || document.body;
  const h1 = dlg.querySelector("h1");
  const authorHref = [...dlg.querySelectorAll('a[href^="/"]')]
    .map((a) => a.getAttribute("href"))
    .find((h) => h.length > 2 && h.startsWith("/") && h.endsWith("/") && !h.slice(1, -1).includes("/"));
  return {
    author: authorHref ? authorHref.slice(1, -1) : null,
    caption: h1 ? h1.innerText.slice(0, 500) : "",
    alreadyLiked: !!document.querySelector('svg[aria-label="Unlike"]'),
  };
});
console.log("RESULT:" + JSON.stringify({ url: await page.url(), ...info }));
`);
}

export function likePost() {
  return run(`${ENSURE}
const hasLike = await page.evaluate(() => !!document.querySelector('svg[aria-label="Like"]'));
if (!hasLike) {
  console.log("RESULT:" + JSON.stringify({ ok: false, reason: "no like button visible (already liked or unexpected screen)" }));
} else {
  await page.click('xpath=//svg[@aria-label="Like"]/ancestor::button[1]', { label: "like post" });
  await page.waitForTimeout(2500);
  const liked = await page.evaluate(() => !!document.querySelector('svg[aria-label="Unlike"]'));
  console.log("RESULT:" + JSON.stringify({ ok: liked, reason: liked ? "verified via Unlike label" : "like label still present after click" }));
}
`);
}

export function closePost() {
  return run(`${ENSURE}
let closed = false;
try {
  await page.click('xpath=//svg[@aria-label="Close"]/ancestor::button[1]', { label: "close post" });
  await page.waitForTimeout(1200);
  closed = true;
} catch (e) {
  // Best-effort: standalone post pages and transient overlays have no Close
  // control. Either way the grid URL below tells the caller where we are.
}
console.log("RESULT:" + JSON.stringify({ closed, url: await page.url() }));
`);
}

// Node runner for the deterministic rule pass: fixture grades plus targeted
// regression checks. Imports the real lib/ modules (no chrome.* is touched at
// import time). Does NOT call OpenAI.
//
// Usage: node tests/run-rules.mjs

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRules, scoreToGrade, normalizeText } from "../lib/rules.js";
import { mergeEvidence } from "../lib/grader.js";
import { htmlToReadableText, isSafeUrl } from "../lib/fetcher.js";
import { defersToFullPolicy, extractPolicyLinks, fullPolicyLinks, looksLikePolicyText, rankPolicyLinks } from "../lib/links.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures");
const RUBRIC_ROOT = join(__dirname, "..", "rubric");

async function loadJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function loadRubric() {
  const [redFlags, goodPractices, weights] = await Promise.all([
    loadJson(join(RUBRIC_ROOT, "red-flags.json")),
    loadJson(join(RUBRIC_ROOT, "good-practices.json")),
    loadJson(join(RUBRIC_ROOT, "weights.json")),
  ]);
  return { redFlags, goodPractices, weights };
}

let pass = 0;
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}

const ids = (r) => r.redFlags.map((f) => f.ruleId);

async function fixtures(rubric) {
  const dirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const name of dirs) {
    const dir = join(FIXTURE_ROOT, name);
    let expected, text;
    try {
      expected = await loadJson(join(dir, "expected.json"));
      text = await readFile(join(dir, "policy.txt"), "utf8");
    } catch {
      continue;
    }
    const got = runRules(normalizeText(text), rubric);
    const grade = scoreToGrade(got.numericScore, rubric.weights).grade;
    const ok = grade === expected.grade && got.autoF === !!expected.autoF && got.autoCapC === !!expected.autoCapC;
    check(`fixture ${name}: grade=${grade} (expected ${expected.grade}), score=${got.numericScore}`, ok, `hit rules: ${ids(got).join(", ")}`);
  }
}

function negation(rubric) {
  const pad = " We collect your email address to run the service.".repeat(3);
  const cases = [
    ["We do not sell your data.", false],
    ["We do not sell personal information.", false],
    ["We will never sell or share your personal information.", false],
    ["We will never change these terms without prior notice to you.", false],
    ["We are not required to notify you of routine maintenance, but we will notify you of any breach.", false],
    ["We sell your personal information to data brokers.", true],
    ["We may sell user data to partners.", true],
  ];
  for (const [sentence, expectAutoF] of cases) {
    const r = runRules(normalizeText(sentence + pad), rubric);
    check(`negation: "${sentence}" autoF=${expectAutoF}`, r.autoF === expectAutoF, `hit rules: ${ids(r).join(", ")}`);
  }
}

// Context-aware rules: an intro to limited disclosures is not broad sharing,
// and ad networks used only for the service's own ads are softened unless
// emails are handed over for retargeting.
function context(rubric) {
  const pad = " We collect your email address to run the service.".repeat(3);
  const flag = (t, id) => runRules(normalizeText(t + pad), rubric).redFlags.find((f) => f.ruleId === id);
  const sharing = [
    ["In addition, we will share personal data with third parties under the limited circumstances described below.", false],
    ["We may share your personal information with third parties, only as required by law.", false],
    ["We share personal data with third parties with your consent.", false],
    ["We share your data with third parties for marketing.", true],
    ["We share personal data with third parties to grow our business, and in limited circumstances with police.", true],
  ];
  for (const [t, expect] of sharing) {
    check(`context: "${t.slice(0, 60)}…" broad-sharing=${expect}`, !!flag(t, "third-party-sharing-broad") === expect);
  }

  const ownAds = "We use ad networks such as Google to show you ads for Acme and the Services.";
  let f = flag(ownAds, "advertising-trackers");
  check("context: own-service ads softened to med", f?.severity === "med" && /own service/.test(f.label), JSON.stringify(f));
  f = flag(ownAds + " Certain advertising networks use your email address to match your online profile, known as email retargeting.", "advertising-trackers");
  check("context: email retargeting keeps high + says so", f?.severity === "high" && /email/i.test(f.label) && /retargeting/.test(f.quote), JSON.stringify(f));
  f = flag(ownAds + " We share device identifiers with advertisers.", "advertising-trackers");
  check("context: third-party advertisers keep the default flag", f?.severity === "high" && f.label === "Shares data with advertisers / trackers", JSON.stringify(f));
  f = flag(ownAds + " We do not sell data to advertisers.", "advertising-trackers");
  check("context: negated advertiser sharing still softens", f?.severity === "med", JSON.stringify(f));
  f = flag("Our ad networks deliver targeted advertising across sites.", "advertising-trackers");
  check("context: plain ad networks keep the default flag", f?.severity === "high" && f.label === "Shares data with advertisers / trackers", JSON.stringify(f));
}

function quotes(rubric) {
  const text = normalizeText(
    "Overview of our practices.\nWe may sell your personal information to advertising partners and\nother companies that help us, Inc. and affiliates. Another sentence here."
  );
  const r = runRules(text, rubric);
  const q = r.redFlags.find((f) => f.ruleId === "sells-data")?.quote || "";
  check("quote: wrapped line stays in one sentence", q.startsWith("We may sell") && q.includes("other companies"), q);
  check("quote: abbreviation is not a sentence end", q.includes("affiliates."), q);
  check("quote: stored match is the matched phrase", /sell your personal information/i.test(r.redFlags.find((f) => f.ruleId === "sells-data")?.match || ""));
}

function merge() {
  const shared = "We collect precise location and a unique device identifier from your phone at all times.";
  const rule = [
    { ruleId: "fingerprinting", label: "Device fingerprinting", quote: shared },
    { ruleId: "location-tracking", label: "Collects precise location", quote: shared },
  ];
  const llm = [
    { label: "Device Fingerprinting", quote: "something else entirely, long enough to shingle here ok" },
    { label: "Tracks location", quote: shared },
    { label: "AI tools may process account data", quote: "Companies providing AI and automation services, specifically named vendors and similar tools." },
  ];
  const out = mergeEvidence(rule, llm).map((h) => h.label);
  check("merge: every rule hit is kept", out.includes("Device fingerprinting") && out.includes("Collects precise location"), out.join(" | "));
  check("merge: LLM duplicates dropped (label and quote)", !out.includes("Device Fingerprinting") && !out.includes("Tracks location"), out.join(" | "));
  check("merge: distinct LLM hit kept", out.includes("AI tools may process account data"), out.join(" | "));
}

function hostileInput(rubric) {
  let t0 = Date.now();
  const ws = "sell" + " ".repeat(200_000) + "x";
  const r = runRules(normalizeText(("disclose" + " ".repeat(50_000) + " ").repeat(4) + ws), rubric);
  check(`hostile whitespace finishes fast (${Date.now() - t0}ms)`, Date.now() - t0 < 1000 && r);

  t0 = Date.now();
  htmlToReadableText("<script".repeat(200_000) + "<" + "a".repeat(100_000));
  check(`hostile HTML finishes fast (${Date.now() - t0}ms)`, Date.now() - t0 < 1000);

  const html = "<html><head><title>x</title><script>var a='<p>no</p>'</script></head><body><nav>menu</nav><main><h1>Privacy</h1><p>We collect data &amp; more.</p>" + "<p>Filler sentence about policy.</p>".repeat(60) + "</main></body></html>";
  const txt = htmlToReadableText(html);
  check("html: main region text extracted, script/nav dropped", txt.replace(/\n+/g, "\n").startsWith("Privacy\nWe collect data & more.") && !txt.includes("menu") && !txt.includes("no"), txt.slice(0, 80));
}

function urls() {
  const ok = ["https://www.fcc.gov/privacy", "https://fdic.gov/x", "https://example.com/terms", "http://[2606:4700::1]/"];
  const bad = ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://192.168.1.1/", "http://100.64.0.1/", "http://router/", "http://nas.lan/", "file:///etc/passwd", "http://2130706433/"];
  for (const u of ok) check(`url allowed: ${u}`, isSafeUrl(u));
  for (const u of bad) check(`url refused: ${u}`, !isSafeUrl(u));
}

// "Legal" hubs that only list the documents must not be graded as a policy;
// the right document is picked from their links instead.
async function hubs() {
  const base = "https://support.example.com/legal-hub";
  const hubHtml = `<html><body><main><h1>Legal, Data Privacy &amp; Security</h1><ul>
    <li><a href="/legal-x1">Legal</a></li>
    <li><a href="/privacy-policy-5tndw">Privacy Policy</a></li>
    <li><a href='/terms-npo'>Terms and Conditions of Use - NPO</a></li>
    <li><a href=/terms-users>Terms and Conditions of Use - <b>Users</b></a></li>
    <li><a href="/terms-referral">Terms and Conditions - Referral Program</a></li>
    <li><a href="/2fa">Activating two-factor authentication</a></li>
    <li><a href="javascript:alert(1)">Privacy settings</a></li>
    <li><a href="${base}#top">Legal hub</a></li>
  </ul></main></body></html>`;
  const hubText = htmlToReadableText(hubHtml);
  check("hub: short index text is not a policy", !looksLikePolicyText(hubText), hubText.slice(0, 80));
  const links = extractPolicyLinks(hubHtml, base);
  const hrefs = links.map((l) => l.href);
  check("hub: policy links extracted and resolved", hrefs.includes("https://support.example.com/privacy-policy-5tndw") && hrefs.includes("https://support.example.com/terms-users"), hrefs.join(" "));
  check("hub: non-policy, javascript: and self links skipped", !hrefs.some((h) => /2fa|javascript|legal-hub/.test(h)), hrefs.join(" "));
  check("hub: nested tags stripped from link text", links.some((l) => l.text === "Terms and Conditions of Use - Users"), links.map((l) => l.text).join(" | "));
  check("hub: ranking picks the privacy policy", rankPolicyLinks(links, "privacy")?.href.endsWith("/privacy-policy-5tndw"));
  check("hub: ranking skips program-specific terms", !rankPolicyLinks(links, "terms")?.href.endsWith("/terms-referral"));

  // Summary articles defer to the full policy and are followed, not graded.
  const summary = "Before we get started, please note that the following article is intended to give you a general overview of our data and security measures. " +
    "All of our payment processing is managed by Stripe. We store data in Canada. We offer 2FA. ".repeat(4) +
    "For more information, please refer to our privacy policy.";
  check("summary: overview reads as a policy but defers (privacy)", looksLikePolicyText(summary) && defersToFullPolicy(summary, "privacy"));
  check("summary: no deferral to terms", !defersToFullPolicy(summary, "terms"));
  check("summary: full-length policy mentioning it is not a summary", !defersToFullPolicy("Please read our Privacy Policy carefully. " + "We collect data to run the service. ".repeat(400), "privacy"));
  const sumLinks = [
    { text: "Legal, Data Privacy & Security", href: "https://support.example.com/legal-data-privacy-security-rt4a1" },
    { text: "Data Privacy", href: "https://support.example.com/verifications-platform-security-k3wkf" },
    { text: "privacy policy", href: "https://support.example.com/privacy-policy-5tndw" },
    { text: "Read more", href: "https://example.com/legal/privacy-notice" },
  ];
  const picked = fullPolicyLinks(sumLinks, "privacy").map((l) => l.href);
  check("summary: only full-policy links are hop candidates", picked.length === 2 && picked[0].endsWith("/privacy-policy-5tndw") && picked[1].endsWith("/privacy-notice"), picked.join(" "));
  check("summary: no terms links among privacy candidates", fullPolicyLinks(sumLinks, "terms").length === 0);

  const fixtureDirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const d of fixtureDirs) {
    const text = await readFile(join(FIXTURE_ROOT, d.name, "policy.txt"), "utf8").catch(() => null);
    if (text) check(`hub: fixture ${d.name} reads as a policy`, looksLikePolicyText(text));
  }

  const t0 = Date.now();
  extractPolicyLinks("<a href=x>".repeat(200_000) + "<a", base);
  extractPolicyLinks("<a href='/privacy'>privacy</a>".repeat(100_000), base);
  check(`hub: hostile link HTML finishes fast (${Date.now() - t0}ms)`, Date.now() - t0 < 1000);
}

async function main() {
  const rubric = await loadRubric();
  await fixtures(rubric);
  negation(rubric);
  context(rubric);
  quotes(rubric);
  merge();
  hostileInput(rubric);
  urls();
  await hubs();
  console.log(`\n${pass}/${total} checks passed.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

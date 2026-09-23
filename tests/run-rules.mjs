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

async function main() {
  const rubric = await loadRubric();
  await fixtures(rubric);
  negation(rubric);
  quotes(rubric);
  merge();
  hostileInput(rubric);
  urls();
  console.log(`\n${pass}/${total} checks passed.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

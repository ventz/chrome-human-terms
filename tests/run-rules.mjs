// Node-only runner for the deterministic rule pass against fixtures.
// Does NOT call OpenAI — this validates the rule-baseline grade only.
//
// Usage: node tests/run-rules.mjs

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// Replicate rules.js logic for node (no chrome.runtime).
function findMatches(text, patterns) {
  for (const raw of patterns) {
    const re = new RegExp(raw, "gi");
    const m = re.exec(text);
    if (m) return [{ offset: m.index, quote: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60) }];
  }
  return [];
}

function runRules(text, rubric) {
  const { redFlags, goodPractices, weights } = rubric;
  const sections = {};
  for (const key of Object.keys(weights.sectionWeights)) {
    sections[key] = weights.defaultSectionScore;
  }
  const hits = [];
  let autoF = false;
  let autoCapC = false;
  for (const rule of redFlags.rules) {
    const m = findMatches(text, rule.patterns);
    if (!m.length) continue;
    hits.push(rule.id);
    sections[rule.section] -= rule.penalty;
    if (rule.autoF) autoF = true;
    if (rule.autoCapC) autoCapC = true;
  }
  const bonusBySection = {};
  for (const rule of goodPractices.rules) {
    const m = findMatches(text, rule.patterns);
    if (!m.length) continue;
    const cap = goodPractices.sectionBonusCap;
    const cur = bonusBySection[rule.section] || 0;
    const add = Math.min(rule.bonus, Math.max(0, cap - cur));
    bonusBySection[rule.section] = cur + add;
  }
  for (const [sec, b] of Object.entries(bonusBySection)) sections[sec] += b;
  for (const k of Object.keys(sections)) sections[k] = Math.max(0, Math.min(100, sections[k]));
  const total = Object.values(weights.sectionWeights).reduce((a, b) => a + b, 0);
  let score = 0;
  for (const [k, w] of Object.entries(weights.sectionWeights)) score += (sections[k] * w) / total;
  let numericScore = Math.round(score);
  if (autoF) numericScore = Math.min(numericScore, 40);
  if (autoCapC) numericScore = Math.min(numericScore, 65);
  const band = weights.bands.find((b) => numericScore >= b.min);
  return { grade: band.grade, numericScore, autoF, autoCapC, hits };
}

async function main() {
  const rubric = await loadRubric();
  const dirs = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let pass = 0;
  let total = 0;
  for (const name of dirs) {
    const dir = join(FIXTURE_ROOT, name);
    let expected, text;
    try {
      expected = JSON.parse(await readFile(join(dir, "expected.json"), "utf8"));
      text = await readFile(join(dir, "policy.txt"), "utf8");
    } catch {
      continue;
    }
    total++;
    const got = runRules(text, rubric);
    const gradeOk = got.grade === expected.grade;
    const autoFOk = got.autoF === !!expected.autoF;
    const autoCapOk = got.autoCapC === !!expected.autoCapC;
    const ok = gradeOk && autoFOk && autoCapOk;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: grade=${got.grade} (expected ${expected.grade}), autoF=${got.autoF}, autoCapC=${got.autoCapC}, score=${got.numericScore}`);
    if (!ok) {
      console.log(`      hit rules: ${got.hits.join(", ")}`);
    }
  }
  console.log(`\n${pass}/${total} fixtures passed the rule-based baseline.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

// Deterministic red-flag / good-practice engine.
// Runs on raw policy text BEFORE any LLM sees it (prompt-injection defense)
// and produces the rule baseline score the LLM cannot override upward beyond
// one letter.

export async function loadRubric() {
  const [redFlags, goodPractices, weights] = await Promise.all([
    fetch(chrome.runtime.getURL("rubric/red-flags.json")).then((r) => r.json()),
    fetch(chrome.runtime.getURL("rubric/good-practices.json")).then((r) => r.json()),
    fetch(chrome.runtime.getURL("rubric/weights.json")).then((r) => r.json()),
  ]);
  return { redFlags, goodPractices, weights };
}

function findMatches(text, patterns) {
  const hits = [];
  for (const raw of patterns) {
    const re = new RegExp(raw, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ offset: m.index, quote: extractQuote(text, m.index, m[0].length) });
      if (hits.length >= 3) break;
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

function extractQuote(text, offset, matchLen) {
  // Tight context: expand to nearest word boundaries, ~40 chars each side.
  let start = Math.max(0, offset - 40);
  let end = Math.min(text.length, offset + matchLen + 40);

  // Snap to word boundaries.
  while (start > 0 && text[start - 1] !== " " && text[start - 1] !== "\n") start--;
  while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;

  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "\u2026 " : "";
  const suffix = end < text.length ? " \u2026" : "";
  return (prefix + raw + suffix).slice(0, 160);
}

export function runRules(text, rubric) {
  const { redFlags, goodPractices, weights } = rubric;
  const sections = {};
  for (const key of Object.keys(weights.sectionWeights)) {
    sections[key] = { raw: weights.defaultSectionScore, flags: [], boosts: [] };
  }

  const hitRedFlags = [];
  let autoF = false;
  let autoCapC = false;

  for (const rule of redFlags.rules) {
    const hits = findMatches(text, rule.patterns);
    if (hits.length === 0) continue;
    hitRedFlags.push({
      ruleId: rule.id,
      label: rule.label,
      severity: rule.severity,
      quote: hits[0].quote,
      offset: hits[0].offset,
    });
    const section = sections[rule.section];
    if (section) {
      section.raw -= rule.penalty;
      section.flags.push(rule.id);
    }
    if (rule.autoF) autoF = true;
    if (rule.autoCapC) autoCapC = true;
  }

  const hitGoodPractices = [];
  const bonusBySection = {};
  for (const rule of goodPractices.rules) {
    const hits = findMatches(text, rule.patterns);
    if (hits.length === 0) continue;
    hitGoodPractices.push({
      ruleId: rule.id,
      label: rule.label,
      quote: hits[0].quote,
      offset: hits[0].offset,
    });
    const cap = goodPractices.sectionBonusCap;
    const current = bonusBySection[rule.section] || 0;
    const add = Math.min(rule.bonus, Math.max(0, cap - current));
    bonusBySection[rule.section] = current + add;
    sections[rule.section]?.boosts.push(rule.id);
  }
  for (const [sec, bonus] of Object.entries(bonusBySection)) {
    if (sections[sec]) sections[sec].raw += bonus;
  }

  for (const sec of Object.values(sections)) {
    sec.raw = Math.max(0, Math.min(100, sec.raw));
  }

  const totalWeight = Object.values(weights.sectionWeights).reduce((a, b) => a + b, 0);
  let weighted = 0;
  for (const [key, w] of Object.entries(weights.sectionWeights)) {
    weighted += (sections[key].raw * w) / totalWeight;
  }

  let numericScore = Math.round(weighted);
  if (autoF) numericScore = Math.min(numericScore, 40);
  if (autoCapC) numericScore = Math.min(numericScore, 65);

  return {
    numericScore,
    autoF,
    autoCapC,
    sectionScores: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.raw])),
    redFlags: hitRedFlags,
    goodPractices: hitGoodPractices,
  };
}

export function scoreToGrade(score, weights) {
  const sorted = [...weights.bands].sort((a, b) => b.min - a.min);
  for (const band of sorted) {
    if (score >= band.min) return band;
  }
  return sorted[sorted.length - 1];
}

export function letterIndex(letter) {
  return ["A", "B", "C", "D", "F"].indexOf(letter);
}

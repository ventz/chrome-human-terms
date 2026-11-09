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

// Upper bound on text scanned by the rubric regexes. Bounds worst-case regex
// time on hostile pages; real policies are far shorter.
export const RULES_MAX_CHARS = 200_000;

// Collapse horizontal whitespace (incl. Unicode spaces) and trim each line, in
// linear time. Run before hashing, rules, and the LLM so offsets and quotes
// agree, and so no rubric regex ever sees a long whitespace run.
export function normalizeText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.replace(/[^\S\n]+/g, " ").trim();
    if (!line) { if (++blank === 1 && out.length) out.push(""); continue; }
    blank = 0;
    out.push(line);
  }
  return out.join("\n").trim();
}

const NEGATION_RE = /\b(not|never|no|don't|do not|won't|will not|doesn't|does not|neither|nor)\b/i;

// True when the match sits in a negated clause ("we do not sell your data").
function isNegated(text, offset) {
  let start = offset;
  const min = Math.max(0, offset - 40);
  while (start > min && !isSentenceEnd(text, start - 1)) start--;
  return NEGATION_RE.test(text.slice(start, offset));
}

// How far past a match exceptWhenFollowedBy looks ("share personal data with
// third parties | under the limited circumstances described below").
const FOLLOW_WINDOW = 60;

function findMatches(text, patterns, { skipNegated = false, exceptFollowedBy = null } = {}) {
  const hits = [];
  for (const raw of patterns) {
    const re = new RegExp(raw, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (skipNegated && isNegated(text, m.index)) continue;
      if (exceptFollowedBy) {
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + FOLLOW_WINDOW);
        if (exceptFollowedBy.test(after)) continue;
      }
      hits.push({ offset: m.index, match: m[0], quote: extractQuote(text, m.index, m[0].length) });
      if (hits.length >= 3) break;
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

const ABBREVIATIONS = new Set(["e.g", "i.e", "inc", "ltd", "co", "corp", "llc", "u.s", "u.k", "etc", "vs", "no", "st", "mr", "ms", "dr", "art", "sec"]);

// A sentence ends at . ! ? ; followed by whitespace (not after a common
// abbreviation), at a blank line, or at a line break that starts a new block
// (heading, list item, capitalized line). A line wrapped mid-sentence is not
// an end.
function isSentenceEnd(text, i) {
  const c = text[i];
  if (c === "\n") {
    const next = text[i + 1] || "";
    const prev = text[i - 1] || "";
    return next === "\n" || prev === "\n" || /[.!?;:]/.test(prev) || /[A-Z0-9•\-*•]/.test(next);
  }
  if (!/[.!?;]/.test(c) || !/\s/.test(text[i + 1] || " ")) return false;
  if (c === ".") {
    let j = i;
    while (j > 0 && /[A-Za-z.]/.test(text[j - 1])) j--;
    if (ABBREVIATIONS.has(text.slice(j, i).toLowerCase())) return false;
  }
  return true;
}

// Quote the sentence containing the match. Long sentences are clipped to a
// window around the match (more room after than before, so the flagged
// clause stays near the start of what the UI shows).
const QUOTE_BEFORE = 100;
const QUOTE_AFTER = 180;

function extractQuote(text, offset, matchLen) {
  let start = offset;
  const minStart = Math.max(0, offset - QUOTE_BEFORE);
  while (start > minStart && !isSentenceEnd(text, start - 1)) start--;
  const startClipped = start > 0 && !isSentenceEnd(text, start - 1);
  if (startClipped) while (start < offset && !/\s/.test(text[start - 1])) start++;

  let end = offset + matchLen;
  const maxEnd = Math.min(text.length, end + QUOTE_AFTER);
  while (end < maxEnd && !isSentenceEnd(text, end)) end++;
  const endClipped = end < text.length && !isSentenceEnd(text, end);
  if (endClipped) while (end > offset + matchLen && !/\s/.test(text[end])) end--;
  else if (end < text.length && text[end] !== "\n") end++; // keep the period

  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (startClipped ? "… " : "") + raw + (endClipped ? " …" : "");
}

// A rule's variants refine its label/severity/penalty from context elsewhere
// in the document: the first variant whose `when` patterns match (and none of
// whose `unless` patterns do) wins, and its matched sentence becomes the
// evidence quote. E.g. ad networks used only to advertise the service itself
// are softened — unless the policy also hands emails over for retargeting.
function pickVariant(text, variants) {
  for (const variant of variants || []) {
    const hit = findMatches(text, variant.when, { skipNegated: true })[0];
    if (!hit) continue;
    if (variant.unless?.length && findMatches(text, variant.unless, { skipNegated: true }).length) continue;
    return { variant, hit };
  }
  return null;
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

  text = text.length > RULES_MAX_CHARS ? text.slice(0, RULES_MAX_CHARS) : text;

  for (const rule of redFlags.rules) {
    // Red flags skip negated clauses unless the rule's own patterns encode
    // the negation (e.g. "we do not offer deletion").
    const exceptFollowedBy = rule.exceptWhenFollowedBy?.length
      ? new RegExp(`^[\\s,]*(?:${rule.exceptWhenFollowedBy.join("|")})`, "i")
      : null;
    const hits = findMatches(text, rule.patterns, { skipNegated: rule.negationSensitive !== false, exceptFollowedBy });
    if (hits.length === 0) continue;
    const v = pickVariant(text, rule.variants);
    const evidence = v?.hit || hits[0];
    hitRedFlags.push({
      ruleId: rule.id,
      label: v?.variant.label || rule.label,
      severity: v?.variant.severity || rule.severity,
      quote: evidence.quote,
      match: evidence.match,
      offset: evidence.offset,
    });
    const section = sections[rule.section];
    if (section) {
      section.raw -= v?.variant.penalty ?? rule.penalty;
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

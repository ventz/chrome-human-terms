// Orchestrates the hybrid grade: rule baseline + LLM structuring + reconciliation.

import { loadRubric, runRules, scoreToGrade, letterIndex } from "./rules.js";
import { callOpenAI } from "./openai.js";
import { validateSummary } from "./schema.js";
import { sha256Hex } from "./cache.js";

// If the raw policy text is longer than this, we truncate for LLM. gpt-5.4
// has plenty of context but long calls are slow and most policies are <60KB.
// Empirically ~60KB keeps end-to-end under ~30s with reasoning:"low".
const LLM_MAX_CHARS = 60_000;

export async function gradePolicy({ text, apiKey, model, documentType = "privacy", signal }) {
  if (!text || text.length < 500) throw new Error("Policy text too short to analyze");

  const hash = await sha256Hex(text);
  const rubric = await loadRubric();

  const rule = runRules(text, rubric);
  const ruleBand = scoreToGrade(rule.numericScore, rubric.weights);

  const truncated = text.length > LLM_MAX_CHARS ? text.slice(0, LLM_MAX_CHARS) : text;

  let llm = null;
  let llmError = null;
  try {
    const res = await callOpenAI({
      apiKey,
      model,
      policyText: truncated,
      ruleHints: rule.redFlags,
      signal,
    });
    const err = validateSummary(res.summary);
    if (err) llmError = `schema: ${err}`;
    else llm = { ...res.summary, _usage: res.usage };
  } catch (e) {
    llmError = e.message;
  }

  const reconciled = reconcile(rule, ruleBand, llm, rubric);

  return {
    ...reconciled,
    policyHash: hash,
    documentType: llm?.documentType || documentType,
    analyzedAt: new Date().toISOString(),
    truncated: text.length > LLM_MAX_CHARS,
    sourceLength: text.length,
    llmError,
    llmUsage: llm?._usage || null,
  };
}

function reconcile(rule, ruleBand, llm, rubric) {
  const ruleLetter = ruleBand.grade;
  const ruleIdx = letterIndex(ruleLetter);

  if (!llm) {
    // LLM failed — rule-only grade with a stub summary.
    return {
      grade: ruleLetter,
      numericScore: rule.numericScore,
      color: ruleBand.color,
      icon: ruleBand.icon,
      verdict: defaultVerdict(ruleLetter, rule),
      confidence: "low",
      jurisdictionsClaimed: [],
      sections: stubSections(ruleLetter, rule),
      redFlags: rule.redFlags,
      goodPractices: rule.goodPractices,
      autoF: rule.autoF,
      autoCapC: rule.autoCapC,
      ruleBaseline: { grade: ruleLetter, score: rule.numericScore },
      llmRaised: false,
      llmLowered: false,
    };
  }

  // LLM may LOWER by any amount, RAISE by at most weights.llmRaiseCapLetters.
  const llmIdx = letterIndex(llm.grade);
  const cap = rubric.weights.llmRaiseCapLetters ?? 1;
  let finalIdx;
  let raised = false;
  let lowered = false;
  if (llmIdx < ruleIdx) {
    // LLM wants to raise (lower index = better letter).
    const maxRaiseIdx = Math.max(0, ruleIdx - cap);
    finalIdx = Math.max(llmIdx, maxRaiseIdx);
    raised = true;
  } else if (llmIdx > ruleIdx) {
    finalIdx = llmIdx;
    lowered = true;
  } else {
    finalIdx = ruleIdx;
  }
  // Auto-F is non-overridable.
  if (rule.autoF) finalIdx = letterIndex("F");
  // Auto-cap-at-C is non-overridable upward.
  if (rule.autoCapC && finalIdx < letterIndex("C")) finalIdx = letterIndex("C");

  const finalLetter = ["A", "B", "C", "D", "F"][finalIdx];
  const finalBand = rubric.weights.bands.find((b) => b.grade === finalLetter);

  // Reconcile numeric score with the final letter so they never disagree in UI.
  const numericFromLetter = finalBand.min + (finalLetter === "A" ? 5 : finalLetter === "F" ? 0 : 7);
  const avg = Math.round((rule.numericScore + (llm.numericScore || numericFromLetter)) / 2);
  const bandMax = getBandMax(rubric.weights, finalLetter);
  const numericScore = Math.min(bandMax, Math.max(finalBand.min, avg));

  const mergedRedFlags = mergeEvidence(rule.redFlags, llm.redFlags || []);
  const mergedGoodPractices = mergeEvidence(rule.goodPractices, llm.goodPractices || []);

  return {
    grade: finalLetter,
    numericScore,
    color: finalBand.color,
    icon: finalBand.icon,
    verdict: llm.verdict || defaultVerdict(finalLetter, rule),
    confidence: llm.confidence || "medium",
    jurisdictionsClaimed: llm.jurisdictionsClaimed || [],
    sections: llm.sections,
    redFlags: mergedRedFlags,
    goodPractices: mergedGoodPractices,
    autoF: rule.autoF,
    autoCapC: rule.autoCapC,
    ruleBaseline: { grade: ruleLetter, score: rule.numericScore },
    llmRaised: raised,
    llmLowered: lowered,
  };
}

function getBandMax(weights, letter) {
  const sorted = [...weights.bands].sort((a, b) => b.min - a.min);
  const idx = sorted.findIndex((b) => b.grade === letter);
  if (idx <= 0) return 100;
  return sorted[idx - 1].min - 1;
}

function mergeEvidence(ruleHits, llmHits) {
  const out = [];
  const seen = new Set();
  for (const h of ruleHits) {
    const key = h.ruleId || h.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  for (const h of llmHits) {
    const key = h.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function defaultVerdict(grade, rule) {
  if (rule.autoF) return "Triggers an automatic F for a critical rights violation.";
  if (rule.autoCapC) return "Capped at C due to arbitration or opaque clauses.";
  return {
    A: "Policy looks unusually user-friendly.",
    B: "Reasonable policy with minor concerns.",
    C: "Mixed — some concerning clauses balanced by user rights.",
    D: "Policy favors the company over the user on key points.",
    F: "Policy contains serious red flags.",
  }[grade];
}

function stubSections(grade, rule) {
  const dims = ["dataCollected", "dataShared", "retention", "yourRights", "security", "clarity"];
  const out = {};
  for (const d of dims) {
    out[d] = {
      grade,
      bullets: ["Full LLM summary unavailable — showing rule-based findings only."],
      evidence: [],
    };
  }
  return out;
}

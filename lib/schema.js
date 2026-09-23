// Strict JSON schema for the LLM structuring pass. OpenAI Responses API strict
// mode requires additionalProperties:false and every property in `required`.

const evidenceItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    quote: { type: "string", description: "Verbatim quote from the policy: one complete sentence, <=300 chars" },
  },
  required: ["quote"],
};

const sectionObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
    bullets: {
      type: "array",
      description: "3-5 plain-English bullets (each <=140 chars)",
      items: { type: "string" },
    },
    evidence: { type: "array", items: evidenceItem },
  },
  required: ["grade", "bullets", "evidence"],
};

export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
    numericScore: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string", description: "One-sentence plain-English take, <=120 chars" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    documentType: { type: "string", enum: ["privacy", "terms", "combined"] },
    jurisdictionsClaimed: {
      type: "array",
      items: { type: "string", enum: ["GDPR", "CCPA", "CPRA", "COPPA", "LGPD", "PIPEDA", "UK-GDPR", "OTHER", "NONE"] },
    },
    sections: {
      type: "object",
      additionalProperties: false,
      properties: {
        dataCollected: sectionObject,
        dataShared: sectionObject,
        retention: sectionObject,
        yourRights: sectionObject,
        security: sectionObject,
        clarity: sectionObject,
      },
      required: ["dataCollected", "dataShared", "retention", "yourRights", "security", "clarity"],
    },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["high", "med"] },
          label: { type: "string" },
          quote: { type: "string" },
        },
        required: ["severity", "label", "quote"],
      },
    },
    goodPractices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          quote: { type: "string" },
        },
        required: ["label", "quote"],
      },
    },
  },
  required: [
    "grade",
    "numericScore",
    "verdict",
    "confidence",
    "documentType",
    "jurisdictionsClaimed",
    "sections",
    "redFlags",
    "goodPractices",
  ],
};

const GRADES = new Set(["A", "B", "C", "D", "F"]);
const SECTION_KEYS = ["dataCollected", "dataShared", "retention", "yourRights", "security", "clarity"];

export function validateSummary(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  for (const k of SUMMARY_SCHEMA.required) if (!(k in obj)) return `missing ${k}`;
  if (!GRADES.has(obj.grade)) return "bad grade";
  if (typeof obj.numericScore !== "number" || obj.numericScore < 0 || obj.numericScore > 100) return "bad numericScore";
  if (!["high", "medium", "low"].includes(obj.confidence)) return "bad confidence";
  if (!["privacy", "terms", "combined"].includes(obj.documentType)) return "bad documentType";
  if (!Array.isArray(obj.jurisdictionsClaimed)) return "jurisdictionsClaimed not array";
  if (typeof obj.verdict !== "string") return "bad verdict";

  const secs = obj.sections;
  if (!secs || typeof secs !== "object") return "missing sections";
  for (const s of SECTION_KEYS) {
    const sec = secs[s];
    if (!sec) return `missing section ${s}`;
    if (!GRADES.has(sec.grade)) return `section ${s}: bad grade`;
    if (!Array.isArray(sec.bullets)) return `section ${s}: bullets not array`;
    if (!Array.isArray(sec.evidence)) return `section ${s}: evidence not array`;
    for (const e of sec.evidence) {
      if (!e || typeof e.quote !== "string") {
        return `section ${s}: bad evidence item`;
      }
    }
  }

  if (!Array.isArray(obj.redFlags)) return "redFlags not array";
  for (const f of obj.redFlags) {
    if (!f || typeof f.label !== "string" || typeof f.quote !== "string") return "bad redFlag item";
    if (!["high", "med"].includes(f.severity)) return "bad redFlag severity";
  }
  if (!Array.isArray(obj.goodPractices)) return "goodPractices not array";
  for (const g of obj.goodPractices) {
    if (!g || typeof g.label !== "string" || typeof g.quote !== "string") return "bad goodPractice item";
  }
  return null;
}

// Finding the actual policy behind a "Legal" link.
// Many sites link their footer to a hub ("Legal & Privacy", "Legal Center")
// that only lists the real documents. Grading the hub gives a meaningless F,
// so after a fetch we check whether the text reads like a policy, and if not,
// pick the right document from the hub's own links and fetch that instead.

// Link text or URL that could point to a policy document.
export const POLICY_LINK_RE = /privacy|terms|conditions|\btos\b|eula|legal|data[\s_-]*(protection|policy|use)|cookie|agreement|notice/i;

const MAX_LINKS = 60;
const MAX_LINK_TEXT = 120;

// A policy is written in sentences; a hub or index page is a list of titles
// with almost none. Count sentence ends (a word followed by "." or ";") —
// line length alone fails on hard-wrapped plain-text policies. Measured:
// Zeffy's legal hub has 0, the shortest test fixture 16, real policies 100+.
const SENTENCE_END_RE = /[\p{Ll}\d)\]"'’”][.;](?=\s|$)/gu;
const MIN_SENTENCES = 10;

export function sentenceCount(text) {
  return (String(text || "").match(SENTENCE_END_RE) || []).length;
}

export function looksLikePolicyText(text) {
  return sentenceCount(text) >= MIN_SENTENCES;
}

// A summary or help-center article ("Data Privacy and Security at Zeffy")
// reads like a policy but defers to the real one ("For more information,
// please refer to our privacy policy"). Graded on its own it gets an F for
// everything it leaves to the full document, so it is followed like a hub.
// Real policies run 20k+ chars; the size cap keeps a full policy that says
// "please read our Privacy Policy carefully" from being skipped. detectorFn
// in background.js inlines the same regexes — keep them in sync.
const MAX_SUMMARY_CHARS = 12_000;
const DEFERS_RE = {
  privacy: /\b(?:refer\s+to|see|read|review|consult|check\s+out)\s+(?:our|the)\s+(?:full\s+|complete\s+)?privacy\s+(?:policy|notice|statement)\b/i,
  terms: /\b(?:refer\s+to|see|read|review|consult|check\s+out)\s+(?:our|the)\s+(?:full\s+|complete\s+)?(?:terms\s+(?:of\s+(?:service|use)|and\s+conditions)|user\s+agreement)\b/i,
};
const FULL_POLICY_LINK_RE = {
  privacy: /privacy[\s_-]*(?:policy|notice|statement)/i,
  terms: /terms[\s_-]*(?:of[\s_-]*(?:service|use)|and[\s_-]*conditions)|\btos\b|user[\s_-]*agreement/i,
};

export function defersToFullPolicy(text, documentType) {
  const re = DEFERS_RE[documentType === "terms" ? "terms" : "privacy"];
  return String(text || "").length <= MAX_SUMMARY_CHARS && re.test(text);
}

// The summary's links that point at the full document it defers to.
export function fullPolicyLinks(links, documentType) {
  const re = FULL_POLICY_LINK_RE[documentType === "terms" ? "terms" : "privacy"];
  return (links || []).filter((l) => re.test(l.text) || re.test(decodeURIComponentSafe(new URL(l.href).pathname)));
}

// Pull policy-looking <a href> links out of raw HTML. Linear scan (no regex
// over the whole document), same reasoning as htmlToReadableText.
export function extractPolicyLinks(html, baseUrl) {
  const lower = html.toLowerCase();
  const out = [];
  const seen = new Set();
  let i = 0;
  while (out.length < MAX_LINKS) {
    const open = lower.indexOf("<a", i);
    if (open < 0) break;
    i = open + 2;
    if (!/[\s>]/.test(lower[open + 2] || "")) continue; // <abbr>, <article>, …
    const gt = html.indexOf(">", open);
    if (gt < 0) break;
    const tag = html.slice(open, Math.min(gt + 1, open + 2048));
    const close = lower.indexOf("</a", gt);
    if (close < 0) break;
    i = close + 3;
    const m = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!m) continue;
    const rawHref = decodeAttr(m[2] ?? m[3] ?? m[4] ?? "");
    const text = linkText(html.slice(gt + 1, Math.min(close, gt + 1 + 4096)));
    let url;
    try { url = new URL(rawHref, baseUrl); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    const href = url.href;
    if (href === baseUrl || seen.has(href)) continue;
    if (!POLICY_LINK_RE.test(text) && !POLICY_LINK_RE.test(url.pathname)) continue;
    seen.add(href);
    out.push({ text: text || url.pathname, href });
  }
  return out;
}

function linkText(inner) {
  let s = "";
  let inTag = false;
  for (const ch of inner) {
    if (ch === "<") inTag = true;
    else if (ch === ">") { inTag = false; s += " "; }
    else if (!inTag) s += ch;
  }
  return decodeAttr(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT);
}

function decodeAttr(s) {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

// Deterministic fallback when no LLM is available (or it fails): score each
// link for the wanted document type and return the best, or null.
export function rankPolicyLinks(links, documentType) {
  let best = null;
  let bestScore = 0;
  for (const l of links) {
    const s = `${l.text} ${decodeURIComponentSafe(l.href)}`.toLowerCase();
    let score = 0;
    if (documentType === "terms") {
      if (/terms\s*(of|and|&)\s*(service|use|conditions)|terms[-_](of|and)[-_](service|use|conditions)/.test(s)) score += 6;
      else if (/\bterms\b|\btos\b|eula|user agreement/.test(s)) score += 3;
      if (/privacy/.test(s)) score -= 2;
    } else {
      if (/privacy[\s_-]*(policy|notice|statement)/.test(s)) score += 6;
      else if (/privacy/.test(s)) score += 3;
      if (/terms|cookie/.test(s)) score -= 2;
    }
    // Program- or product-specific documents are rarely the one users mean.
    if (/referral|reward|cash[\s-]*back|affiliate|partner|developer|api|security|2fa|archive|previous|faq/.test(s)) score -= 3;
    if (score > bestScore) { best = l; bestScore = score; }
  }
  return best;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

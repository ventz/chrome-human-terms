// Service worker. Central router for:
//   - DETECT (scan active tab for policy page or candidate links)
//   - ANALYZE (fetch + rule + LLM grade)
//   - DIFF (compare cached previous text with current text of same origin)
//   - OPEN_REPORT (persist result + open full-tab report)
//   - HIGHLIGHT_ON_PAGE (inject highlighter into the tab)
//   - GET_LAST_REPORT, GET_ORIGIN_RECORD
// Also owns chrome.action badge, context menus, and keyboard commands.

import { gradePolicy } from "./lib/grader.js";
import { fetchPolicyText } from "./lib/fetcher.js";
import {
  getCached,
  setCached,
  sha256Hex,
  getOriginRecord,
  setOriginRecord,
  originOf,
} from "./lib/cache.js";
import { callDiffSummary } from "./lib/openai.js";

const GRADE_BADGE_COLORS = {
  A: "#15803d",
  B: "#4d7c0f",
  C: "#a16207",
  D: "#c2410c",
  F: "#b91c1c",
};

// In-memory per-tab cache of last seen text (used by the diff flow, since
// storage.session cannot hold large policy text across SW restarts reliably).
const tabTextCache = new Map(); // tabId -> { text, origin, hash }

// Users provide their own OpenAI API key via the extension's Options page.
async function getConfig() {
  const { openaiApiKey, openaiModel } = await chrome.storage.local.get(["openaiApiKey", "openaiModel"]);
  return {
    apiKey: openaiApiKey || null,
    model: (openaiModel && openaiModel.trim()) || "gpt-5.4",
  };
}

// ---------- Detector (injected into the active tab) ----------

const detectorFn = () => {
  const KEYS = /(privacy\s*(policy|notice|statement)?|terms(\s+(of\s+)?(service|use|sale))?|tos|eula|legal\s*(notice|terms)?|data\s*(protection|policy|use)|cookie\s*(policy|notice))/i;
  const TRIGS = [
    /personal\s+(data|information)/i,
    /collect(ed|s)?\s+.{0,40}\s+information/i,
    /cookies/i,
    /third\s*parties/i,
    /retention/i,
    /GDPR|CCPA|COPPA/i,
    /arbitration/i,
  ];
  const path = location.pathname.toLowerCase();
  const h1 = (document.querySelector("h1")?.textContent || "").trim();
  const title = document.title || "";
  const bodyText = document.body?.innerText || "";
  const urlHit = KEYS.test(path) || KEYS.test(title) || KEYS.test(h1);
  const triggerCount = TRIGS.reduce((n, re) => (re.test(bodyText) ? n + 1 : n), 0);
  const isPolicy = urlHit && triggerCount >= 3 && bodyText.length > 1500;

  const scope =
    document.querySelector("footer") ||
    document.querySelector("[role=contentinfo]") ||
    document.querySelector("#footer") ||
    document.querySelector(".footer") ||
    document.body;
  const anchors = Array.from(scope.querySelectorAll("a[href]"));
  const seen = new Set();
  const candidates = [];
  for (const a of anchors) {
    const t = (a.textContent || "").trim();
    const h = a.href;
    if (!t || !h || h.startsWith("javascript:")) continue;
    if (!KEYS.test(t) && !KEYS.test(h)) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    let kind = "legal";
    const s = t + " " + h;
    if (/privacy/i.test(s)) kind = "privacy";
    else if (/terms|tos|eula|conditions/i.test(s)) kind = "terms";
    else if (/cookie/i.test(s)) kind = "cookies";
    candidates.push({ text: t, href: h, kind });
    if (candidates.length >= 8) break;
  }

  let pageText = null;
  if (isPolicy) {
    const selectors = ["main", "article", "[role=main]", ".policy", ".privacy", ".terms", ".legal", "#content", ".content"];
    let best = null;
    let bestLen = 0;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const len = (el.innerText || "").length;
        if (len > bestLen) {
          best = el;
          bestLen = len;
        }
      }
    }
    if (!best || bestLen < 1500) best = document.body;
    // Clone the node and strip non-content elements so the extracted text
    // closely matches what fetchPolicyText produces from raw HTML. This
    // prevents false "policy changed" alerts caused by nav/footer/banner
    // text that only appears in the live DOM's innerText.
    const clone = best.cloneNode(true);
    for (const tag of ["nav", "footer", "header", "aside", "form", "script", "style", "noscript", "svg", "template"]) {
      for (const el of clone.querySelectorAll(tag)) el.remove();
    }
    // Also strip cookie-consent banners and common overlay widgets.
    for (const sel of [
      "[class*='cookie']", "[id*='cookie']",
      "[class*='consent']", "[id*='consent']",
      "[class*='banner']", "[id*='banner']",
      "[role='banner']", "[role='navigation']", "[role='contentinfo']",
    ]) {
      for (const el of clone.querySelectorAll(sel)) el.remove();
    }
    pageText = (clone.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  return { url: location.href, title, h1, isPolicy, triggerCount, candidates, pageText };
};

async function detectInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: detectorFn,
    world: "ISOLATED",
  });
  return results?.[0]?.result || null;
}

// ---------- Highlighter (injected on demand) ----------

const highlighterFn = (payload) => {
  const items = payload.items || [];
  if (!items.length) return { ok: false, reason: "no items" };

  // Clean up any previous run.
  for (const el of document.querySelectorAll("mark[data-ht]")) {
    const p = el.parentNode;
    if (!p) continue;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
    p.normalize();
  }
  document.getElementById("ht-bar")?.remove();
  document.getElementById("ht-style")?.remove();

  // Inject styles.
  const css = document.createElement("style");
  css.id = "ht-style";
  css.textContent = `
    mark[data-ht] { padding: 1px 3px; border-radius: 3px; cursor: pointer; position: relative; transition: box-shadow 0.15s; }
    mark[data-ht][data-sev="high"] { background: #fecaca; box-shadow: 0 0 0 1px #f87171; }
    mark[data-ht][data-sev="med"]  { background: #fed7aa; box-shadow: 0 0 0 1px #fdba74; }
    mark[data-ht][data-sev="good"] { background: #bbf7d0; box-shadow: 0 0 0 1px #86efac; }
    mark[data-ht].ht-active { box-shadow: 0 0 0 3px #2563eb !important; }
    #ht-bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 8px; background: #1e293b; color: #f1f5f9; padding: 8px 14px; border-radius: 10px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.35); max-width: 640px; }
    #ht-bar button { background: #334155; border: none; color: #f1f5f9; padding: 5px 10px; border-radius: 5px; cursor: pointer; font: inherit; font-size: 12px; }
    #ht-bar button:hover { background: #475569; }
    #ht-bar .ht-counter { font-weight: 600; min-width: 60px; text-align: center; }
    #ht-bar .ht-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    #ht-bar .ht-sev { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-right: 6px; }
    #ht-bar .ht-sev.high { background: #dc2626; color: white; }
    #ht-bar .ht-sev.med  { background: #ea580c; color: white; }
    #ht-bar .ht-sev.good { background: #16a34a; color: white; }
    #ht-bar .ht-close { background: transparent; font-size: 16px; padding: 2px 6px; margin-left: 4px; }
  `;
  document.head.appendChild(css);

  // Clean a quote for searching: strip ellipsis, collapse whitespace, normalize quotes.
  const cleanQ = (q) => (q || "")
    .replace(/^\u2026\s*/, "").replace(/\s*\u2026$/, "")
    .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Normalize a single char for comparison.
  const normChar = (c) => {
    if (/\s/.test(c)) return " ";
    if ("\u201c\u201d\u00ab\u00bb".includes(c)) return '"';
    if ("\u2018\u2019\u0060\u00b4".includes(c)) return "'";
    return c;
  };

  // Build concatenated text from all visible text nodes + an explicit
  // raw→norm mapping so range lookups are accurate.
  const textNodes = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = n.parentElement?.tagName;
      if (tag && /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|OBJECT|TEXTAREA|INPUT)$/i.test(tag))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let fullText = "";
  while (tw.nextNode()) {
    const start = fullText.length;
    const val = tw.currentNode.nodeValue;
    fullText += val;
    textNodes.push({ node: tw.currentNode, start, end: start + val.length });
  }

  // Build bidirectional mapping: normToRaw[normIdx] = rawIdx, rawToNorm[rawIdx] = normIdx.
  const normToRaw = []; // normToRaw[i] = raw index of the i-th norm char
  let normStr = "";
  let prevWasSpace = false;
  for (let r = 0; r < fullText.length; r++) {
    const nc = normChar(fullText[r]);
    if (nc === " ") {
      if (prevWasSpace) continue; // collapse
      prevWasSpace = true;
    } else {
      prevWasSpace = false;
    }
    normToRaw.push(r);
    normStr += nc;
  }
  // Also track raw index AFTER the last norm char for end-of-range.
  normToRaw.push(fullText.length);

  function normRangeToDOM(normStart, normLen) {
    if (normStart < 0 || normStart + normLen > normStr.length) return null;
    const rawStart = normToRaw[normStart];
    const rawEnd = normToRaw[normStart + normLen];
    if (rawStart == null || rawEnd == null) return null;

    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const tn of textNodes) {
      if (!startNode && rawStart < tn.end) {
        startNode = tn.node;
        startOff = rawStart - tn.start;
      }
      if (rawEnd <= tn.end) {
        endNode = tn.node;
        endOff = rawEnd - tn.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    try {
      const r = document.createRange();
      r.setStart(startNode, Math.min(startOff, startNode.nodeValue.length));
      r.setEnd(endNode, Math.min(endOff, endNode.nodeValue.length));
      return r;
    } catch { return null; }
  }

  // Try to find each item in the normalized full text.
  const normLower = normStr.toLowerCase();
  const marks = []; // { el, item }
  for (const item of items) {
    const needle = cleanQ(item.quote);
    if (!needle || needle.length < 10) continue;

    // Try full → middle portion → first 50 chars.
    const words = needle.split(/\s+/);
    const keyPhrase = words.length > 8
      ? words.slice(Math.floor(words.length * 0.15), Math.ceil(words.length * 0.85)).join(" ")
      : needle;
    const attempts = [needle, keyPhrase, needle.slice(0, 50)];
    const tried = new Set();

    for (const attempt of attempts) {
      if (!attempt || attempt.length < 8 || tried.has(attempt)) continue;
      tried.add(attempt);

      // Normalize the needle the same way we normalized fullText.
      let normNeedle = "";
      let pws = false;
      for (const ch of attempt) {
        const nc = normChar(ch);
        if (nc === " ") { if (pws) continue; pws = true; } else { pws = false; }
        normNeedle += nc;
      }
      normNeedle = normNeedle.trim();
      if (normNeedle.length < 6) continue;

      const idx = normLower.indexOf(normNeedle.toLowerCase());
      if (idx < 0) continue;

      const range = normRangeToDOM(idx, normNeedle.length);
      if (!range || range.collapsed) continue;

      try {
        const mark = document.createElement("mark");
        mark.setAttribute("data-ht", "0");
        mark.setAttribute("data-sev", item.severity || (item.good ? "good" : "med"));
        mark.setAttribute("data-label", item.label || "");
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
        marks.push({ el: mark, item });
        break;
      } catch {
        // Range couldn't wrap — try next attempt.
      }
    }
  }

  if (!marks.length) return { ok: true, matched: 0, attempted: items.length };

  // Sort marks by vertical position on the page (top → bottom = Next direction).
  marks.sort((a, b) => {
    const ar = a.el.getBoundingClientRect();
    const br = b.el.getBoundingClientRect();
    return ar.top - br.top || ar.left - br.left;
  });
  // Re-assign sequential indices after sorting.
  marks.forEach((m, i) => { m.idx = i; m.el.setAttribute("data-ht", String(i)); });

  // Build the floating nav bar.
  let current = 0;
  const bar = document.createElement("div");
  bar.id = "ht-bar";
  bar.innerHTML = `
    <button id="ht-prev" title="Previous (Shift+F3)">\u2190 Prev</button>
    <span class="ht-counter"><span id="ht-cur">1</span> / ${marks.length}</span>
    <button id="ht-next" title="Next (F3)">Next \u2192</button>
    <span class="ht-label" id="ht-info"></span>
    <button class="ht-close" id="ht-close" title="Close highlights">\u00d7</button>
  `;
  document.body.appendChild(bar);

  function goTo(idx) {
    marks[current]?.el.classList.remove("ht-active");
    current = ((idx % marks.length) + marks.length) % marks.length;
    const m = marks[current];
    m.el.classList.add("ht-active");
    m.el.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("ht-cur").textContent = String(current + 1);
    const sev = m.item.severity || (m.item.good ? "good" : "med");
    const sevLabel = sev === "high" ? "Red flag" : sev === "good" ? "Good practice" : "Concern";
    document.getElementById("ht-info").innerHTML =
      `<span class="ht-sev ${sev}">${sevLabel}</span>${m.item.label || ""}`;
  }

  document.getElementById("ht-prev").addEventListener("click", () => goTo(current - 1));
  document.getElementById("ht-next").addEventListener("click", () => goTo(current + 1));
  document.getElementById("ht-close").addEventListener("click", () => {
    for (const { el } of marks) {
      const p = el.parentNode;
      if (!p) continue;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
      p.normalize();
    }
    bar.remove();
    css.remove();
  });

  // Clicking a mark jumps to it in the nav.
  for (const m of marks) {
    m.el.addEventListener("click", () => goTo(m.idx));
  }

  // Keyboard: F3 next, Shift+F3 prev.
  document.addEventListener("keydown", function htKey(e) {
    if (!document.getElementById("ht-bar")) { document.removeEventListener("keydown", htKey); return; }
    if (e.key === "F3" && !e.shiftKey) { e.preventDefault(); goTo(current + 1); }
    else if (e.key === "F3" && e.shiftKey) { e.preventDefault(); goTo(current - 1); }
    else if (e.key === "Escape") { document.getElementById("ht-close")?.click(); }
  });

  goTo(0);
  return { ok: true, matched: marks.length, attempted: items.length };
};

async function highlightOnTab(tabId, items) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: highlighterFn,
    args: [{ items }],
    world: "ISOLATED",
  });
  return results?.[0]?.result || { ok: false };
}

// ---------- URL safety ----------

function isSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "169.254.169.254" || host === "metadata.google.internal") return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((n) => parseInt(n, 10));
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
  }
  if (/^\[?(::1|fc|fd|fe80)/i.test(host)) return false;
  return true;
}

function sanitizeErrorMessage(s) {
  if (!s) return "";
  return String(s)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***REDACTED***")
    .slice(0, 400);
}

// ---------- Badge + per-tab ----------

async function setTabBadge(tabId, grade) {
  if (!tabId) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: grade || "" });
    if (grade) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: GRADE_BADGE_COLORS[grade] || "#475569" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
      }
    }
  } catch (e) {
    console.warn("[HumanTerms] setBadge failed:", e.message);
  }
}

async function refreshBadgeForTab(tabId, url) {
  const origin = originOf(url);
  if (!origin) { await setTabBadge(tabId, ""); return; }
  const rec = await getOriginRecord(origin);
  if (rec?.grade) await setTabBadge(tabId, rec.grade);
  else await setTabBadge(tabId, "");
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "complete" && tab?.url) {
    refreshBadgeForTab(tabId, tab.url);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) refreshBadgeForTab(tabId, tab.url);
  } catch {}
});
chrome.tabs.onRemoved.addListener((tabId) => { tabTextCache.delete(tabId); });

// ---------- Install / context menu / commands ----------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  chrome.contextMenus.create({
    id: "analyze-link",
    title: "Analyze this policy link",
    contexts: ["link"],
    targetUrlPatterns: ["https://*/*", "http://*/*"],
  });
  chrome.contextMenus.create({
    id: "analyze-page",
    title: "Analyze this page as a policy",
    contexts: ["page"],
    documentUrlPatterns: ["https://*/*", "http://*/*"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "analyze-link" && info.linkUrl) {
    await analyzeAndShow(tab.id, { fetchUrl: info.linkUrl });
  } else if (info.menuItemId === "analyze-page") {
    await analyzeAndShow(tab.id, { fromActiveTab: true });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "analyze-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await analyzeAndShow(tab.id, { fromActiveTab: true });
});

// Shared one-shot flow: detect → analyze → persist → open report + badge.
async function analyzeAndShow(tabId, opts) {
  try {
    const { apiKey, model } = await getConfig();
    if (!apiKey) {
      chrome.runtime.openOptionsPage();
      return;
    }
    let payloadText, documentType, sourceUrl;
    if (opts.fromActiveTab) {
      const info = await detectInTab(tabId);
      if (info?.isPolicy && info.pageText) {
        payloadText = info.pageText;
        documentType = guessDocType(info.title, info.url);
        sourceUrl = info.url;
      } else if (info?.candidates?.length) {
        const pick = info.candidates.find((c) => c.kind === "privacy") || info.candidates[0];
        const { text, finalUrl } = await fetchPolicyText(pick.href);
        payloadText = text;
        documentType = pick.kind === "terms" ? "terms" : "privacy";
        sourceUrl = finalUrl;
      } else {
        return;
      }
    } else if (opts.fetchUrl) {
      if (!isSafeUrl(opts.fetchUrl)) return;
      const { text, finalUrl } = await fetchPolicyText(opts.fetchUrl);
      payloadText = text;
      documentType = /terms|tos|eula/i.test(opts.fetchUrl) ? "terms" : "privacy";
      sourceUrl = finalUrl;
    } else {
      return;
    }
    if (!payloadText || payloadText.length < 500) return;

    const hash = await sha256Hex(payloadText);
    let result = await getCached(hash);
    if (!result || result.llmError) {
      result = await gradePolicy({ text: payloadText, apiKey, model, documentType });
      result.sourceUrl = sourceUrl;
      if (!result.llmError) await setCached(hash, result);
    }
    await rememberOrigin(sourceUrl, result, payloadText, hash);
    await setTabBadge(tabId, result.grade);
    await chrome.storage.session.set({ lastReport: result });
    await chrome.tabs.create({ url: chrome.runtime.getURL("report/report.html") });
  } catch (e) {
    console.warn("[HumanTerms] analyzeAndShow failed:", sanitizeErrorMessage(e.message));
  }
}

async function rememberOrigin(sourceUrl, result, text, hash) {
  const origin = originOf(sourceUrl);
  if (!origin) return;
  await setOriginRecord(origin, {
    hash,
    grade: result.grade,
    numericScore: result.numericScore,
    documentType: result.documentType,
    sourceUrl,
    analyzedAt: result.analyzedAt,
    textSample: text.slice(0, 40_000), // for later diff
  });
}

function guessDocType(title, url) {
  const s = `${title || ""} ${url || ""}`.toLowerCase();
  if (/terms|tos|eula|conditions/.test(s)) return "terms";
  return "privacy";
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "DETECT") {
        const tab = msg.tabId
          ? await chrome.tabs.get(msg.tabId)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id) throw new Error("No active tab");
        const info = await detectInTab(tab.id);
        // Diff detection: if we know this origin and the hash has drifted, flag it.
        let changed = null;
        if (info?.isPolicy && info.pageText) {
          const hash = await sha256Hex(info.pageText);
          tabTextCache.set(tab.id, { text: info.pageText, origin: originOf(info.url), hash });
          const rec = await getOriginRecord(originOf(info.url));
          if (rec && rec.hash && rec.hash !== hash) {
            changed = {
              previousGrade: rec.grade,
              previousAt: rec.analyzedAt,
              previousHash: rec.hash,
            };
          }
        }
        sendResponse({ ok: true, info, tabId: tab.id, changed });
        return;
      }

      if (msg.type === "ANALYZE") {
        const { apiKey, model } = await getConfig();
        if (!apiKey) { sendResponse({ ok: false, error: "NO_API_KEY" }); return; }
        console.log("[HumanTerms] ANALYZE start:", msg.fetchUrl || msg.sourceUrl || "(page text)");
        const { text, documentType, sourceUrl } = await resolvePolicyText(msg);
        if (!text || text.length < 500) {
          sendResponse({ ok: false, error: "Policy text too short or could not be extracted." });
          return;
        }
        const hash = await sha256Hex(text);
        // Check if the policy changed since we last saw this origin.
        let changed = null;
        const origin = originOf(sourceUrl);
        if (origin) {
          const rec = await getOriginRecord(origin);
          if (rec && rec.hash && rec.hash !== hash) {
            changed = { previousGrade: rec.grade, previousAt: rec.analyzedAt, previousHash: rec.hash };
          }
        }
        if (!msg.forceRefresh) {
          const cached = await getCached(hash);
          if (cached && !cached.llmError) {
            await rememberOrigin(sourceUrl, cached, text, hash);
            if (msg.tabId) await setTabBadge(msg.tabId, cached.grade);
            sendResponse({ ok: true, result: cached, cached: true, changed });
            return;
          }
        }
        const result = await gradePolicy({ text, apiKey, model, documentType });
        result.sourceUrl = sourceUrl;
        if (!result.llmError) await setCached(hash, result);
        await rememberOrigin(sourceUrl, result, text, hash);
        if (msg.tabId) await setTabBadge(msg.tabId, result.grade);
        sendResponse({ ok: true, result, cached: false, changed });
        return;
      }

      if (msg.type === "DIFF") {
        // msg: { origin, currentText }
        const { apiKey, model } = await getConfig();
        if (!apiKey) { sendResponse({ ok: false, error: "NO_API_KEY" }); return; }
        const rec = await getOriginRecord(msg.origin);
        if (!rec?.textSample) { sendResponse({ ok: false, error: "No previous text cached for diff." }); return; }
        const summary = await callDiffSummary({
          apiKey,
          model,
          previousText: rec.textSample,
          currentText: msg.currentText,
        });
        sendResponse({ ok: true, diff: summary, previous: rec });
        return;
      }

      if (msg.type === "GET_LAST_REPORT") {
        const { lastReport } = await chrome.storage.session.get("lastReport");
        sendResponse({ ok: true, report: lastReport || null });
        return;
      }

      if (msg.type === "OPEN_REPORT") {
        await chrome.storage.session.set({ lastReport: msg.result });
        await chrome.tabs.create({ url: chrome.runtime.getURL("report/report.html") });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "HIGHLIGHT") {
        const tabId = msg.tabId;
        if (!tabId) { sendResponse({ ok: false, error: "No tabId" }); return; }
        const res = await highlightOnTab(tabId, msg.items || []);
        sendResponse({ ok: res.ok !== false, ...res });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: sanitizeErrorMessage(err?.message || String(err)) });
    }
  })();
  return true;
});

async function resolvePolicyText(msg) {
  if (msg.text) {
    return { text: msg.text, documentType: msg.documentType || "privacy", sourceUrl: msg.sourceUrl || null };
  }
  if (msg.fetchUrl) {
    if (!isSafeUrl(msg.fetchUrl)) throw new Error("Refusing to fetch URL (non-public host or non-http scheme).");
    const { text, unsupported, finalUrl } = await fetchPolicyText(msg.fetchUrl);
    if (finalUrl && !isSafeUrl(finalUrl)) throw new Error("Refusing redirect to non-public host.");
    if (unsupported === "pdf") throw new Error("PDF policies are not supported yet.");
    if (unsupported === "too-short") throw new Error("Fetched page was too short to analyze.");
    return { text, documentType: msg.documentType || "privacy", sourceUrl: finalUrl };
  }
  throw new Error("No text or fetchUrl provided");
}

// Open side panel when toolbar icon is clicked (no popup).
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

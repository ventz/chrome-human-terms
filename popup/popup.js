const $ = (id) => document.getElementById(id);
const SECTION_LABELS = {
  dataCollected: "What they collect",
  dataShared: "Who they share with",
  retention: "How long they keep it",
  yourRights: "Your rights",
  security: "Security",
  clarity: "Policy clarity",
};
const GRADE_ICONS = { A: "\u2713", B: "\u2713", C: "\u26a0", D: "\u26a0", F: "\u26d4" };
const GRADE_COLORS = { A: "#15803d", B: "#4d7c0f", C: "#a16207", D: "#c2410c", F: "#b91c1c" };

let detection = null;
let activeTabId = null;
let chosenCandidate = null;
let currentResult = null;
let activeTab = "tldr"; // tldr | flags | good | sections
let elapsedTimer = null;
let tipTimer = null;
let analysisAborted = false;
let diffOrigin = null;

init();

async function init() {
  $("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("analyze-btn").addEventListener("click", () => onAnalyze(false));
  $("refresh-btn").addEventListener("click", () => onAnalyze(true));
  $("error-back").addEventListener("click", () => showState("initial"));
  $("open-report-btn").addEventListener("click", onOpenReport);
  $("side-panel-btn").addEventListener("click", onOpenSidePanel);
  $("highlight-btn").addEventListener("click", onHighlight);
  $("cancel-btn").addEventListener("click", onCancel);
  $("diff-btn").addEventListener("click", onDiff);
  $("diff-back").addEventListener("click", () => showState("initial"));
  $("diff-reanalyze").addEventListener("click", () => onAnalyze(true));
  $("copy-btn").addEventListener("click", onCopy);
  $("export-btn").addEventListener("click", onExport);
  for (const id of ["tab-tldr", "tab-flags", "tab-good", "tab-sections"]) {
    $(id).addEventListener("click", () => switchTab(id.replace("tab-", "")));
  }

  const resp = await chrome.runtime.sendMessage({ type: "DETECT" });
  if (!resp?.ok) { showError(resp?.error || "Could not inspect the page. Try reloading the tab."); return; }
  detection = resp.info;
  activeTabId = resp.tabId;
  if (resp.changed) showChangedBanner(resp.changed);
  renderDetection();
}

function renderDetection() {
  const div = $("detection");
  div.innerHTML = "";
  if (!detection) return;
  const line = document.createElement("div");
  if (detection.isPolicy) {
    line.innerHTML = `<span class="dot found" aria-hidden="true"></span>This page looks like a policy.`;
    $("analyze-btn").disabled = false;
    chosenCandidate = { source: "page" };
  } else if (detection.candidates?.length) {
    line.innerHTML = `<span class="dot notfound" aria-hidden="true"></span>Not a policy page. Found ${detection.candidates.length} policy link${detection.candidates.length === 1 ? "" : "s"}:`;
  } else {
    line.innerHTML = `<span class="dot notfound" aria-hidden="true"></span>No policy page or link found in this tab.`;
  }
  div.appendChild(line);

  const candDiv = $("candidates");
  candDiv.innerHTML = "";
  if (!detection.isPolicy && detection.candidates?.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Click a link to analyze it:";
    candDiv.appendChild(hint);
    for (const c of detection.candidates) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "candidate";
      row.setAttribute("aria-label", `Analyze ${c.kind} policy: ${c.text}`);
      row.innerHTML = `<span>${escapeHtml(c.text)}</span><span class="kind" aria-hidden="true">${escapeHtml(c.kind)} &rarr;</span>`;
      row.addEventListener("click", () => { chosenCandidate = { source: "fetch", ...c }; onAnalyze(false); });
      candDiv.appendChild(row);
    }
    $("analyze-btn").hidden = true;
  } else {
    $("analyze-btn").hidden = false;
  }
}

function showChangedBanner(changed, sourceUrl) {
  const b = $("changed-banner");
  const when = changed.previousAt ? new Date(changed.previousAt).toLocaleString() : "earlier";
  b.textContent = `Policy changed since you last reviewed it (${when}, was ${changed.previousGrade}). Re-analyze or see what changed.`;
  b.hidden = false;
  // Diff only works when we have the current policy text on-page.
  const url = sourceUrl || detection?.url;
  try { diffOrigin = new URL(url).origin; } catch {}
  $("diff-btn").hidden = !detection?.isPolicy;
}

async function onAnalyze(forceRefresh) {
  if (!chosenCandidate) return;
  analysisAborted = false;
  showState("loading");
  $("loading-msg").textContent = forceRefresh ? "Re-analyzing policy" : "Analyzing policy";
  startElapsedTimer();

  const payload = { type: "ANALYZE", forceRefresh: forceRefresh === true, tabId: activeTabId };
  if (chosenCandidate.source === "page") {
    payload.text = detection.pageText;
    payload.sourceUrl = detection.url;
    payload.documentType = guessDocType(detection.title, detection.url);
  } else {
    payload.fetchUrl = chosenCandidate.href;
    payload.documentType = chosenCandidate.kind === "terms" ? "terms" : "privacy";
  }

  let resp;
  try { resp = await chrome.runtime.sendMessage(payload); }
  catch (e) {
    stopElapsedTimer();
    if (analysisAborted) return;
    showError(e?.message || "Extension service worker unavailable. Try reloading the extension.");
    return;
  }
  stopElapsedTimer();
  if (analysisAborted) return;
  if (!resp?.ok) {
    if (resp?.error === "NO_API_KEY") showError("No OpenAI API key set. Click the gear icon to configure.");
    else showError(resp?.error || "Analysis failed.");
    return;
  }
  if (resp.changed && !forceRefresh) showChangedBanner(resp.changed, resp.result?.sourceUrl);
  renderResult(resp.result, resp.cached);
}

function onCancel() { analysisAborted = true; stopElapsedTimer(); showState("initial"); }

function startElapsedTimer() {
  const start = Date.now();
  const el = $("loading-elapsed");
  const tip = $("loading-tip");
  tip.hidden = true;
  el.textContent = "0s";
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }, 500);
  tipTimer = setTimeout(() => { tip.hidden = false; }, 15_000);
}
function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
}

async function onOpenReport() {
  if (!currentResult) return;
  await chrome.runtime.sendMessage({ type: "OPEN_REPORT", result: currentResult });
}
async function onOpenSidePanel() {
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: activeTabId });
      await chrome.sidePanel.setOptions({ tabId: activeTabId, path: "sidepanel/sidepanel.html", enabled: true });
      window.close();
    } else {
      toast("Side panel not supported in this Chrome version.");
    }
  } catch (e) {
    toast("Open the side panel from the Chrome toolbar > Reading list icon.");
  }
}
async function onHighlight() {
  if (!currentResult || !activeTabId) return;
  const items = [
    ...(currentResult.redFlags || []).map((f) => ({ quote: f.quote, label: f.label, severity: f.severity || "med" })),
    ...(currentResult.goodPractices || []).map((g) => ({ quote: g.quote, label: g.label, good: true })),
  ];
  const resp = await chrome.runtime.sendMessage({ type: "HIGHLIGHT", tabId: activeTabId, items });
  if (resp?.ok) toast(`Highlighted ${resp.matched || 0} of ${resp.attempted || items.length} passages on the page.`);
  else toast("Couldn't highlight (this may not be the policy page).");
}

async function onDiff() {
  if (!diffOrigin || !detection?.pageText) { toast("Open the policy page itself to see the diff."); return; }
  showState("loading");
  $("loading-msg").textContent = "Comparing to previous version";
  startElapsedTimer();
  let resp;
  try { resp = await chrome.runtime.sendMessage({ type: "DIFF", origin: diffOrigin, currentText: detection.pageText }); }
  catch (e) { stopElapsedTimer(); showError(e?.message || "Diff failed."); return; }
  stopElapsedTimer();
  if (!resp?.ok) { showError(resp?.error || "Diff failed."); return; }
  renderDiff(resp.diff);
}

function renderDiff(d) {
  $("diff-summary").textContent = d.summary;
  const container = $("diff-changes");
  container.innerHTML = "";
  for (const c of d.changes || []) {
    const div = document.createElement("div");
    div.className = `diff-change ${c.impact}`;
    div.innerHTML = `<span class="kind">${escapeHtml(c.kind)} \u00b7 ${escapeHtml(c.area)}</span>${escapeHtml(c.description)}`;
    container.appendChild(div);
  }
  showState("diff");
}

function renderResult(result, cached) {
  currentResult = result;
  showState("result");

  const badge = $("grade-badge");
  const color = result.color || GRADE_COLORS[result.grade] || "#475569";
  const icon = result.icon || GRADE_ICONS[result.grade] || "";
  badge.innerHTML = `<span>${escapeHtml(result.grade || "?")}</span><span class="icon" aria-hidden="true">${escapeHtml(icon)}</span>`;
  badge.style.background = color;
  badge.setAttribute("aria-label", `Grade ${result.grade}: ${result.verdict || ""}`);

  $("verdict").textContent = result.verdict;
  $("confidence").textContent = `Confidence: ${result.confidence} \u00b7 Score ${result.numericScore}/100 \u00b7 ${result.documentType}`;
  $("source-line").textContent = result.sourceUrl || "";

  const banners = $("banners");
  banners.innerHTML = "";
  if (result.autoF) addBanner(banners, "auto-f", "Auto-F: critical clause triggers an automatic F.", true);
  if (result.autoCapC && !result.autoF) addBanner(banners, "auto-c", "Auto-capped at C due to arbitration/class-action waiver.", true);
  if (result.llmRaised) addBanner(banners, "raised", "LLM raised the grade from the rule baseline (capped at one letter).");
  if (result.llmLowered) addBanner(banners, "lowered", "Lowered the grade based on nuance in the text.");
  if (cached) addBanner(banners, "cached", "Cached result (policy text unchanged). Use Re-analyze to refresh.");
  if (result.llmError) addBanner(banners, "auto-c", `LLM step failed \u2014 showing rule-based findings only.`, true);

  renderEvidence($("red-flags"), result.redFlags, "sev");
  renderEvidence($("good-practices"), result.goodPractices, "good");
  $("count-flags").textContent = String((result.redFlags || []).length);
  $("count-good").textContent = String((result.goodPractices || []).length);

  const sec = $("sections");
  sec.innerHTML = "";
  for (const [key, data] of Object.entries(result.sections || {})) {
    const band = GRADE_COLORS[data.grade] || "#475569";
    const row = document.createElement("div");
    row.className = "section-row";
    row.innerHTML = `
      <div class="section-grade" style="background:${band}" aria-label="Grade ${escapeHtml(data.grade || "?")}">${escapeHtml(data.grade || "?")}</div>
      <div class="section-body">
        <div class="section-name">${escapeHtml(SECTION_LABELS[key] || key)}</div>
        <ul>${(data.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
      </div>`;
    sec.appendChild(row);
  }

  const view = $("view-source");
  const sourceUrl = result.sourceUrl || detection?.url || null;
  if (sourceUrl && /^https?:/.test(sourceUrl)) {
    view.hidden = false;
    view.setAttribute("href", sourceUrl);
    view.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: sourceUrl }); };
  } else { view.hidden = true; }

  $("tldr-content").innerHTML = generateTldr(result);

  switchTab(activeTab);
}

function switchTab(which) {
  activeTab = which;
  for (const k of ["tldr", "flags", "good", "sections"]) {
    $(`tab-${k}`).setAttribute("aria-selected", String(k === which));
    $(`panel-${k}`).hidden = k !== which;
  }
}

function generateTldr(r) {
  const docLabel = r.documentType === "terms" ? "terms of service" : r.documentType === "combined" ? "policy" : "privacy policy";
  const parts = [];

  // Opening line
  parts.push(`<p class="tldr-intro">This ${escapeHtml(docLabel)} gets a <strong>${escapeHtml(r.grade)}</strong> (${r.numericScore}/100). ${escapeHtml(r.verdict || "")}</p>`);

  // Section synthesis
  const secs = r.sections || {};
  const GRADE_RANK = { A: 5, B: 4, C: 3, D: 2, F: 1 };
  const entries = Object.entries(secs).map(([k, v]) => ({ key: k, label: SECTION_LABELS[k] || k, grade: v.grade, rank: GRADE_RANK[v.grade] || 0 }));
  const worst = entries.filter((e) => e.rank <= 2).sort((a, b) => a.rank - b.rank);
  const best = entries.filter((e) => e.rank >= 4).sort((a, b) => b.rank - a.rank);

  const summaryParts = [];
  if (worst.length) summaryParts.push("Weakest areas: " + worst.map((e) => `${e.label} (${e.grade})`).join(", ") + ".");
  if (best.length) summaryParts.push("Strongest areas: " + best.map((e) => `${e.label} (${e.grade})`).join(", ") + ".");
  if (!worst.length && !best.length) summaryParts.push("All sections scored average (C).");
  parts.push(`<p class="tldr-sections">${escapeHtml(summaryParts.join(" "))}</p>`);

  // Key concerns
  const flags = (r.redFlags || []).slice(0, 3);
  if (flags.length) {
    parts.push(`<div class="tldr-list"><strong>Watch out for:</strong><ul>${flags.map((f) => `<li>${escapeHtml(f.label)}</li>`).join("")}</ul></div>`);
  }

  // Bright spots
  const good = (r.goodPractices || []).slice(0, 3);
  if (good.length) {
    parts.push(`<div class="tldr-list"><strong>On the plus side:</strong><ul>${good.map((g) => `<li>${escapeHtml(g.label)}</li>`).join("")}</ul></div>`);
  }

  // Bottom line
  let bottomLine;
  if (r.grade === "A" || r.grade === "B") bottomLine = "Overall, this is a relatively user-friendly policy.";
  else if (r.grade === "C") bottomLine = "This policy is middle-of-the-road \u2014 not terrible, but there\u2019s room for improvement.";
  else bottomLine = "This policy is not great for users. Proceed with caution.";
  parts.push(`<p class="tldr-bottom"><em>${escapeHtml(bottomLine)}</em></p>`);

  return parts.join("");
}

function renderEvidence(ul, items, kindPrefix) {
  ul.innerHTML = "";
  if (!items?.length) {
    const li = document.createElement("li");
    li.className = "evidence-item";
    li.textContent = kindPrefix === "good" ? "No good-practice matches found." : "No red flags detected by rules or LLM.";
    ul.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const cls = kindPrefix === "good" ? "good" : `sev-${item.severity || "med"}`;
    li.className = `evidence-item ${cls}`;
    const quote = truncateQuote(item.quote, 140);
    li.innerHTML = `<span class="evidence-label">${escapeHtml(item.label)}</span>${quote ? `<span class="evidence-quote">${escapeHtml(quote)}</span>` : ""}`;
    ul.appendChild(li);
  }
}

function addBanner(parent, cls, text, alert) {
  const div = document.createElement("div");
  div.className = `banner ${cls}`;
  div.textContent = text;
  if (alert) div.setAttribute("role", "alert");
  parent.appendChild(div);
}

async function onCopy() {
  if (!currentResult) return;
  const text = formatActiveTabAsMarkdown(currentResult, activeTab);
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    // Fallback: temporary textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied");
  }
}

function formatActiveTabAsMarkdown(r, which) {
  const header = `# ${r.grade} — ${r.verdict || "Policy summary"}\nSource: ${r.sourceUrl || "(n/a)"}\n\n`;
  if (which === "tldr") {
    const docLabel = r.documentType === "terms" ? "terms of service" : r.documentType === "combined" ? "policy" : "privacy policy";
    const lines = [`This ${docLabel} gets a **${r.grade}** (${r.numericScore}/100). ${r.verdict || ""}\n`];
    const secs = r.sections || {};
    const GRADE_RANK = { A: 5, B: 4, C: 3, D: 2, F: 1 };
    const entries = Object.entries(secs).map(([k, v]) => ({ label: SECTION_LABELS[k] || k, grade: v.grade, rank: GRADE_RANK[v.grade] || 0 }));
    const worst = entries.filter((e) => e.rank <= 2).sort((a, b) => a.rank - b.rank);
    const best = entries.filter((e) => e.rank >= 4).sort((a, b) => b.rank - a.rank);
    if (worst.length) lines.push("Weakest areas: " + worst.map((e) => `${e.label} (${e.grade})`).join(", ") + ".");
    if (best.length) lines.push("Strongest areas: " + best.map((e) => `${e.label} (${e.grade})`).join(", ") + ".");
    const flags = (r.redFlags || []).slice(0, 3);
    if (flags.length) lines.push("\n**Watch out for:**\n" + flags.map((f) => `- ${f.label}`).join("\n"));
    const good = (r.goodPractices || []).slice(0, 3);
    if (good.length) lines.push("\n**On the plus side:**\n" + good.map((g) => `- ${g.label}`).join("\n"));
    return header + `## TLDR\n${lines.join("\n")}\n`;
  }
  if (which === "flags") {
    const items = (r.redFlags || []).map((f) => `- **${f.label}** (${f.severity || "med"})\n  > ${(f.quote || "").trim()}`).join("\n");
    return header + `## Red flags\n${items || "- None detected."}\n`;
  }
  if (which === "good") {
    const items = (r.goodPractices || []).map((g) => `- **${g.label}**\n  > ${(g.quote || "").trim()}`).join("\n");
    return header + `## Good practices\n${items || "- None detected."}\n`;
  }
  const sections = Object.entries(r.sections || {}).map(([k, data]) => {
    const bullets = (data.bullets || []).map((b) => `  - ${b}`).join("\n");
    return `### ${SECTION_LABELS[k] || k} — ${data.grade}\n${bullets}`;
  }).join("\n\n");
  return header + `## Section-by-section\n${sections}\n`;
}

function formatFullReportMarkdown(r) {
  const lines = [];
  lines.push(`# Policy Report: Grade ${r.grade} (${r.numericScore}/100)`);
  lines.push(`> ${r.verdict || ""}`);
  lines.push("");
  if (r.sourceUrl) lines.push(`**Source:** ${r.sourceUrl}`);
  lines.push(`**Type:** ${r.documentType || "policy"} | **Confidence:** ${r.confidence || "unknown"} | **Analyzed:** ${r.analyzedAt || ""}`);
  if (r.jurisdictionsClaimed?.length) lines.push(`**Jurisdictions claimed:** ${r.jurisdictionsClaimed.join(", ")}`);
  lines.push("");

  if (r.autoF) lines.push(`> **AUTO-F:** Critical clause triggers an automatic F.`);
  if (r.autoCapC && !r.autoF) lines.push(`> **AUTO-CAP C:** Capped at C due to arbitration/class-action waiver.`);
  lines.push("");

  lines.push("## TLDR");
  lines.push(r.verdict || "");
  const tldrSecs = r.sections || {};
  const TR = { A: 5, B: 4, C: 3, D: 2, F: 1 };
  const tldrEntries = Object.entries(tldrSecs).map(([k, v]) => ({ label: SECTION_LABELS[k] || k, grade: v.grade, rank: TR[v.grade] || 0 }));
  const tw = tldrEntries.filter((e) => e.rank <= 2).sort((a, b) => a.rank - b.rank);
  const tb = tldrEntries.filter((e) => e.rank >= 4).sort((a, b) => b.rank - a.rank);
  if (tw.length) lines.push("Weakest: " + tw.map((e) => `${e.label} (${e.grade})`).join(", "));
  if (tb.length) lines.push("Strongest: " + tb.map((e) => `${e.label} (${e.grade})`).join(", "));
  lines.push("");

  lines.push("## Red flags");
  for (const f of (r.redFlags || [])) {
    lines.push(`- **${f.label}** (${f.severity || "med"})`);
    if (f.quote) lines.push(`  > ${f.quote.trim()}`);
  }
  if (!(r.redFlags || []).length) lines.push("- None detected.");
  lines.push("");

  lines.push("## Good practices");
  for (const g of (r.goodPractices || [])) {
    lines.push(`- **${g.label}**`);
    if (g.quote) lines.push(`  > ${g.quote.trim()}`);
  }
  if (!(r.goodPractices || []).length) lines.push("- None detected.");
  lines.push("");

  lines.push("## Section-by-section");
  for (const [k, data] of Object.entries(r.sections || {})) {
    lines.push(`### ${SECTION_LABELS[k] || k} — ${data.grade}`);
    for (const b of (data.bullets || [])) lines.push(`- ${b}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Directional guidance, not legal advice. Grade is a readability / user-friendliness score.*");
  return lines.join("\n");
}

function onExport() {
  if (!currentResult) return;
  const md = formatFullReportMarkdown(currentResult);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const domain = currentResult.sourceUrl ? new URL(currentResult.sourceUrl).hostname.replace(/^www\./, "") : "policy";
  a.href = url;
  a.download = `${domain}-${currentResult.grade}-report.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Exported markdown report");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2000);
}

function showState(name) {
  for (const s of ["initial", "loading", "error", "result", "diff"]) {
    const el = $(`state-${s}`);
    if (el) el.hidden = s !== name;
  }
}
function showError(msg) { $("error-msg").textContent = msg; showState("error"); }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function truncateQuote(q, max) {
  if (!q) return "";
  const clean = q.replace(/^\u2026\s*/, "").replace(/\s*\u2026$/, "").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + " \u2026";
}

function guessDocType(title, url) {
  const s = `${title} ${url}`.toLowerCase();
  if (/terms|tos|eula|conditions/.test(s)) return "terms";
  return "privacy";
}

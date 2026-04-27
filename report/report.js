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

init();

async function init() {
  $("print-btn").addEventListener("click", () => window.print());
  const resp = await chrome.runtime.sendMessage({ type: "GET_LAST_REPORT" });
  if (!resp?.ok || !resp.report) {
    $("empty").hidden = false;
    return;
  }
  render(resp.report);
}

function render(r) {
  $("report").hidden = false;
  document.title = `${r.grade || "?"} · Policy report · Human Terms`;

  const color = r.color || GRADE_COLORS[r.grade] || "#475569";
  const icon = r.icon || GRADE_ICONS[r.grade] || "";
  const badge = $("grade-badge");
  badge.innerHTML = `<span>${escapeHtml(r.grade || "?")}</span><span class="icon" aria-hidden="true">${escapeHtml(icon)}</span>`;
  badge.style.background = color;
  badge.setAttribute("aria-label", `Grade ${r.grade}: ${r.verdict || ""}`);

  $("doc-kind").textContent = `${r.documentType || "policy"} \u00b7 confidence ${r.confidence || "unknown"}`;
  $("verdict").textContent = r.verdict || "";

  const src = $("source-line");
  if (r.sourceUrl && /^https?:/.test(r.sourceUrl)) {
    src.innerHTML = `Source: <a href="${escapeAttr(r.sourceUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtml(r.sourceUrl)}</a>`;
    const chip = $("view-source");
    chip.hidden = false;
    chip.setAttribute("href", r.sourceUrl);
    chip.setAttribute("target", "_blank");
    chip.setAttribute("rel", "noopener noreferrer");
  } else {
    src.textContent = "";
  }

  const meta = [];
  if (typeof r.numericScore === "number") meta.push(`Score ${r.numericScore}/100`);
  if (r.ruleBaseline) meta.push(`Rule baseline ${r.ruleBaseline.grade} (${r.ruleBaseline.score}/100)`);
  if (r.jurisdictionsClaimed?.length) meta.push(`Claims: ${r.jurisdictionsClaimed.join(", ")}`);
  $("meta-line").textContent = meta.join("  \u00b7  ");
  $("analyzed-at").textContent = r.analyzedAt ? new Date(r.analyzedAt).toLocaleString() : "";

  const banners = $("banners");
  banners.innerHTML = "";
  if (r.autoF) addBanner(banners, "auto-f", "Auto-F: a critical clause triggers an automatic F.", true);
  if (r.autoCapC && !r.autoF) addBanner(banners, "auto-c", "Grade capped at C due to arbitration / class-action waiver or vague legitimate-interest terms.", true);
  if (r.llmRaised) addBanner(banners, "raised", "The LLM raised the grade from the rule baseline (raise limit: one letter).");
  if (r.llmLowered) addBanner(banners, "lowered", "The LLM lowered the grade based on nuance in the text.");
  if (r.llmError) addBanner(banners, "auto-c", `LLM step failed \u2014 showing rule-based findings only.`, true);

  renderEvidence($("red-flags"), r.redFlags, "sev", "No red flags detected.");
  renderEvidence($("good-practices"), r.goodPractices, "good", "No good-practice matches found.");

  const sec = $("sections");
  sec.innerHTML = "";
  for (const [key, data] of Object.entries(r.sections || {})) {
    const band = GRADE_COLORS[data.grade] || "#475569";
    const card = document.createElement("div");
    card.className = "section-card";
    const ic = GRADE_ICONS[data.grade] || "";
    card.innerHTML = `
      <div class="section-grade" style="background:${band}" aria-label="Grade ${escapeHtml(data.grade || "?")}">${escapeHtml(data.grade || "?")}<span aria-hidden="true" style="font-size:11px;margin-left:2px;opacity:.85">${escapeHtml(ic)}</span></div>
      <div class="section-body">
        <div class="section-name">${escapeHtml(SECTION_LABELS[key] || key)}</div>
        <ul>${(data.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
      </div>`;
    sec.appendChild(card);
  }
}

function renderEvidence(ul, items, kindPrefix, emptyMsg) {
  ul.innerHTML = "";
  if (!items?.length) {
    const li = document.createElement("li");
    li.className = "evidence-item";
    li.textContent = emptyMsg;
    ul.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const cls = kindPrefix === "good" ? "good" : `sev-${item.severity || "med"}`;
    li.className = `evidence-item ${cls}`;
    li.innerHTML = `
      <span class="label">${escapeHtml(item.label)}</span>
      <span class="quote">${escapeHtml(item.quote || "")}</span>`;
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

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

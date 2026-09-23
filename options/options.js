import { listCached, clearAllCached } from "../lib/cache.js";
import { DEFAULT_MODEL } from "../lib/openai.js";

const $ = (id) => document.getElementById(id);

async function load() {
  const { openaiApiKey, openaiModel } = await chrome.storage.local.get(["openaiApiKey", "openaiModel"]);
  if (openaiApiKey) $("apiKey").value = openaiApiKey;
  // An empty setting means "use the extension's default", which follows
  // upgrades; only an explicitly chosen model is stored.
  $("model").placeholder = DEFAULT_MODEL;
  $("model").value = openaiModel && openaiModel !== DEFAULT_MODEL ? openaiModel : "";
  renderCache();
}

async function save() {
  const apiKey = $("apiKey").value.trim();
  const typed = $("model").value.trim();
  const model = typed === DEFAULT_MODEL ? "" : typed;
  if (apiKey && !apiKey.startsWith("sk-")) {
    setStatus("That doesn't look like an OpenAI key (expected sk-…).", "err");
    return;
  }
  await chrome.storage.local.set({ openaiApiKey: apiKey, openaiModel: model });
  setStatus("Saved.", "ok");
}

async function clearKey() {
  await chrome.storage.local.remove("openaiApiKey");
  $("apiKey").value = "";
  setStatus("API key cleared.", "ok");
}

function toggleShow() {
  const el = $("apiKey");
  el.type = el.type === "password" ? "text" : "password";
}

async function renderCache() {
  const entries = await listCached();
  const container = $("cacheList");
  container.innerHTML = "";
  if (!entries.length) {
    container.innerHTML = `<p class="lede">No cached analyses yet.</p>`;
    return;
  }
  for (const e of entries.sort((a, b) => (b.analyzedAt || "").localeCompare(a.analyzedAt || ""))) {
    const row = document.createElement("li");
    row.className = "cache-row";
    const label = e.sourceUrl || `policy ${e.hash.slice(0, 12)}…`;
    row.innerHTML = `<span>${escapeHtml(label)}</span><span><strong>${escapeHtml(e.grade || "?")}</strong> · ${escapeHtml(e.documentType || "")} · ${escapeHtml((e.analyzedAt || "").slice(0, 10))}</span>`;
    container.appendChild(row);
  }
}

async function clearCache() {
  const n = await clearAllCached();
  setStatus(`Cleared ${n} cached entries and review history.`, "ok");
  renderCache();
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${cls}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("save").addEventListener("click", save);
$("clear").addEventListener("click", clearKey);
$("show").addEventListener("click", toggleShow);
$("clearCache").addEventListener("click", clearCache);
load();

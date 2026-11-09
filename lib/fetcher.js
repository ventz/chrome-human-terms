// Fetches a URL and reduces it to plain readable text.
// Runs inside the MV3 service worker which has NO DOMParser, so this uses a
// small linear-time tag scanner. Good enough for policy prose — we don't need
// perfect structure, just the text. (Regex stripping of the form
// /<script[\s\S]*?<\/script>/ goes quadratic on hostile input such as many
// unclosed <script tags, which would hang the service worker.)

import { extractPolicyLinks } from "./links.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const ACCEPTED_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

// Refuse non-http(s) schemes and hosts that are obviously local/private.
// Note: fetch() in an extension cannot inspect redirect hops before following
// them (redirect:"manual" yields an opaque response with no Location), so the
// final URL is re-checked after the fact, and DNS names that resolve to
// private addresses cannot be caught here.
export function isSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();

  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::" || v6 === "::1") return false;
    if (/^(fc|fd|fe[89ab])/.test(v6)) return false; // ULA + link-local
    if (/^::ffff:/.test(v6)) return false; // IPv4-mapped
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((n) => parseInt(n, 10));
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false;
    return true;
  }

  if (!host.includes(".")) return false; // single-label intranet names
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa|corp|intranet|localdomain)$/.test(host)) return false;
  if (host === "metadata.google.internal") return false;
  return true;
}

export async function fetchPolicyText(url, { signal, timeoutMs = 30_000 } = {}) {
  if (!isSafeUrl(url)) throw new Error("Refusing to fetch URL (non-public host or non-http scheme).");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`Fetch timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  const onAbort = () => ac.abort(signal.reason || new Error("Cancelled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const resp = await fetch(url, { signal: ac.signal, credentials: "omit", redirect: "follow" });
    if (resp.url && !isSafeUrl(resp.url)) throw new Error("Refusing redirect to non-public host.");
    if (!resp.ok) throw new Error(`Fetch ${url} -> ${resp.status}`);
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/pdf")) {
      resp.body?.cancel().catch(() => {});
      return { text: "", unsupported: "pdf", finalUrl: resp.url };
    }
    if (ct && !ACCEPTED_TYPES.some((t) => ct.includes(t))) {
      resp.body?.cancel().catch(() => {});
      throw new Error(`Unsupported content type: ${ct.split(";")[0]}`);
    }
    const body = await readCapped(resp);
    const isPlain = ct.includes("text/plain");
    const text = isPlain ? body : htmlToReadableText(body);
    const links = isPlain ? [] : extractPolicyLinks(body, resp.url || url);
    return { text, links, unsupported: text.length < 500 ? "too-short" : null, finalUrl: resp.url };
  } catch (e) {
    if (ac.signal.aborted) throw new Error(ac.signal.reason?.message || "Fetch aborted/timed out");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Read the body as text, refusing anything larger than MAX_BODY_BYTES.
async function readCapped(resp) {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error(`Page is too large to analyze (over ${MAX_BODY_BYTES / 1024 / 1024} MB).`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

// Elements whose whole content is dropped.
const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "svg", "template", "nav", "footer", "header", "aside", "form", "head"]);
// Elements that end a line.
const BLOCK_ELEMENTS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "br", "ul", "ol", "table", "main", "blockquote", "dd", "dt"]);

export function htmlToReadableText(html) {
  const region = extractMainRegion(html) || html;
  const parts = [];
  let i = 0;
  const lower = region.toLowerCase();
  while (i < region.length) {
    const lt = region.indexOf("<", i);
    if (lt < 0) { parts.push(region.slice(i)); break; }
    parts.push(region.slice(i, lt));

    if (region.startsWith("<!--", lt)) {
      const endc = region.indexOf("-->", lt + 4);
      if (endc < 0) break;
      i = endc + 3;
      continue;
    }
    const gt = region.indexOf(">", lt + 1);
    if (gt < 0) break;
    const m = /^<\/?\s*([a-z][a-z0-9-]*)/i.exec(region.slice(lt, Math.min(gt + 1, lt + 64)));
    const name = m ? m[1].toLowerCase() : "";
    const closing = region[lt + 1] === "/";
    i = gt + 1;

    if (!closing && SKIP_ELEMENTS.has(name) && region[gt - 1] !== "/") {
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) break;
      const closeGt = region.indexOf(">", close);
      i = closeGt < 0 ? region.length : closeGt + 1;
      parts.push(" ");
      continue;
    }
    parts.push(BLOCK_ELEMENTS.has(name) ? "\n" : " ");
  }

  const text = decodeEntities(parts.join(""));
  // Linear whitespace cleanup: collapse runs within lines, trim lines, keep
  // at most one blank line between blocks.
  const out = [];
  let blank = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[^\S\n]+/g, " ").trim();
    if (!line) { if (++blank === 1 && out.length) out.push(""); continue; }
    blank = 0;
    out.push(line);
  }
  return out.join("\n").trim();
}

// Prefer the largest <main> or <article> region when it holds enough text.
function extractMainRegion(html) {
  const lower = html.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const tag of ["main", "article"]) {
    let from = 0;
    for (;;) {
      const open = lower.indexOf(`<${tag}`, from);
      if (open < 0) break;
      const after = lower[open + tag.length + 1];
      from = open + tag.length + 1;
      if (after && !/[\s>/]/.test(after)) continue; // e.g. <mainframe>
      const gt = html.indexOf(">", open);
      const close = lower.indexOf(`</${tag}`, gt);
      if (gt < 0 || close < 0) break;
      const inner = html.slice(gt + 1, close);
      if (inner.length > bestLen) { best = inner; bestLen = inner.length; }
      from = close;
    }
  }
  return bestLen >= 1500 ? best : null;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&");
}

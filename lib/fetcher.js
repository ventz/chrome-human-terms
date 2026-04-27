// Fetches a URL and reduces it to plain readable text.
// Runs inside the MV3 service worker which has NO DOMParser, so this uses
// regex-based tag stripping. Good enough for policy prose — we don't need
// perfect structure, just the text.

export async function fetchPolicyText(url, { signal, timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`Fetch timeout after ${Math.round(timeoutMs/1000)}s`)), timeoutMs);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", () => ac.abort(signal.reason));
  }
  let resp;
  try {
    resp = await fetch(url, { signal: ac.signal, credentials: "omit", redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted) throw new Error(ac.signal.reason?.message || "Fetch aborted/timed out");
    throw e;
  }
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`Fetch ${url} -> ${resp.status}`);
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/pdf")) {
    return { text: "", unsupported: "pdf", finalUrl: resp.url };
  }
  const html = await resp.text();
  const text = htmlToReadableText(html);
  return { text, unsupported: text.length < 500 ? "too-short" : null, finalUrl: resp.url };
}

function htmlToReadableText(html) {
  // Try to isolate a main-content container first by grabbing its inner HTML.
  const regionHtml = extractMainRegion(html) || html;

  const stripped = regionHtml
    // Drop non-visible / non-content elements.
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Turn block-ish tags into newlines so paragraph breaks survive.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip every remaining tag.
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(stripped)
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
}

// Prefer the largest content-ish region. We look for <main>, <article>, or
// elements with common policy container classes/ids, and pick the chunk whose
// text (after crude stripping) is longest.
function extractMainRegion(html) {
  const patterns = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<[^>]*(?:id|class)\s*=\s*"[^"]*(?:policy|privacy|terms|legal|content|main)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi,
  ];
  let best = null;
  let bestLen = 0;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const inner = m[1];
      const approxLen = inner.replace(/<[^>]+>/g, " ").length;
      if (approxLen > bestLen) {
        best = inner;
        bestLen = approxLen;
      }
    }
  }
  return bestLen >= 1500 ? best : null;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code >= 0x20 && code < 0x10000 ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code >= 0x20 && code < 0x10000 ? String.fromCodePoint(code) : " ";
    });
}

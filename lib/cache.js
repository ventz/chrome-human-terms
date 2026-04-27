// Policy-hash-keyed cache in chrome.storage.local.
//
// Two keyspaces:
//   policy:<sha256>    -> full result object (content-hash keyed)
//   origin:<origin>    -> { hash, grade, analyzedAt, documentType, sourceUrl }
// The origin map lets us detect "policy changed since last review" without
// re-fetching a full result.

const POLICY_PREFIX = "policy:";
const ORIGIN_PREFIX = "origin:";

export async function sha256Hex(text) {
  // Light normalization: collapse whitespace so minor rendering differences
  // (extra blank lines, trailing spaces) don't cause false hash mismatches.
  // Case is preserved — "MAY share" vs "will share" is a real change.
  const normalized = text
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
  const buf = new TextEncoder().encode(normalized);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCached(hash) {
  const key = POLICY_PREFIX + hash;
  const obj = await chrome.storage.local.get(key);
  return obj[key] || null;
}

export async function setCached(hash, entry) {
  const key = POLICY_PREFIX + hash;
  await chrome.storage.local.set({ [key]: entry });
}

export async function listCached() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(POLICY_PREFIX))
    .map(([k, v]) => ({ hash: k.slice(POLICY_PREFIX.length), ...v }));
}

export function originKey(origin) {
  return ORIGIN_PREFIX + origin;
}

export async function getOriginRecord(origin) {
  if (!origin) return null;
  const key = originKey(origin);
  const obj = await chrome.storage.local.get(key);
  return obj[key] || null;
}

export async function setOriginRecord(origin, record) {
  if (!origin) return;
  await chrome.storage.local.set({ [originKey(origin)]: record });
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

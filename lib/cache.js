// Policy-hash-keyed cache in chrome.storage.local.
//
// Two keyspaces:
//   policy:v3:<model>:<sha256> -> full result object (content-hash keyed)
//   doc:v2:<origin+path> -> { hash, grade, analyzedAt, documentType, sourceUrl, textSample, prevTextSample }
// The per-document map lets us detect "policy changed since last review"
// without re-fetching a full result.

import { normalizeText } from "./rules.js";

// Bump the version when grading output changes so stale results re-grade.
// Keys also include the model, so switching models never serves another
// model's result.
export const POLICY_PREFIX = "policy:v3:";
export const ORIGIN_PREFIX = "doc:v2:";
const LEGACY_PREFIXES = ["policy:", "origin:"];

export async function sha256Hex(text) {
  // Light normalization: collapse whitespace so minor rendering differences
  // (extra blank lines, trailing spaces) don't cause false hash mismatches.
  // Case is preserved — "MAY share" vs "will share" is a real change.
  const normalized = normalizeText(text).split("\n").filter(Boolean).join("\n");
  const buf = new TextEncoder().encode(normalized);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function policyKey(hash, model) {
  return `${POLICY_PREFIX}${model || "default"}:${hash}`;
}

export async function getCached(hash, model) {
  const key = policyKey(hash, model);
  const obj = await chrome.storage.local.get(key);
  return obj[key] || null;
}

export async function setCached(hash, model, entry) {
  const key = policyKey(hash, model);
  await chrome.storage.local.set({ [key]: entry });
}

export async function listCached() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(POLICY_PREFIX))
    .map(([k, v]) => ({ hash: k.slice(k.lastIndexOf(":") + 1), ...v }));
}

// "Last reviewed" records are per document (origin + path), not per site, so
// a site's privacy policy and its terms don't overwrite each other.
export function docKeyOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function getDocRecord(docKey) {
  if (!docKey) return null;
  const key = ORIGIN_PREFIX + docKey;
  const obj = await chrome.storage.local.get(key);
  return obj[key] || null;
}

export async function setDocRecord(docKey, record) {
  if (!docKey) return;
  await chrome.storage.local.set({ [ORIGIN_PREFIX + docKey]: record });
}

// Latest record for any document on this origin (used for the toolbar badge).
export async function getLatestRecordForOrigin(origin) {
  if (!origin) return null;
  const all = await chrome.storage.local.get(null);
  let best = null;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(ORIGIN_PREFIX + origin + "/") && k !== ORIGIN_PREFIX + origin) continue;
    if (!best || (v.analyzedAt || "") > (best.analyzedAt || "")) best = v;
  }
  return best;
}

// Remove everything this extension has cached: results, per-document
// records (which hold text samples), and keys from older versions.
export async function clearAllCached() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) =>
    k.startsWith(POLICY_PREFIX) || k.startsWith(ORIGIN_PREFIX) || LEGACY_PREFIXES.some((p) => k.startsWith(p)));
  await chrome.storage.local.remove(keys);
  return keys.length;
}

// Drop keys written by older versions (called on install/update).
export async function removeLegacyKeys() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) =>
    !k.startsWith(POLICY_PREFIX) && !k.startsWith(ORIGIN_PREFIX) && LEGACY_PREFIXES.some((p) => k.startsWith(p)));
  if (keys.length) await chrome.storage.local.remove(keys);
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

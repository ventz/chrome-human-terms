# Policy in Human Terms

A Chrome extension that translates a website's privacy policy or terms of
service into a scannable human summary with a letter grade (A–F), color-coded
severity, evidence quotes, and flagged red-flag clauses.

## Features (v1)

- Click the toolbar icon to analyze the current page. No background scanning.
- Auto-detects whether the current page IS a policy, or scrapes footer links
  to candidate Privacy/ToS/Cookie pages and lets you pick one.
- **Hybrid grading:** deterministic rule engine (`rubric/red-flags.json`,
  `rubric/good-practices.json`) sets the baseline. OpenAI `gpt-5.4` via the
  Responses API structures the summary and extracts evidence quotes. The LLM
  can *lower* the grade any amount but can only *raise* it by one letter, and
  cannot override `autoF` / `autoCapC` triggers.
- Every claim carries a quoted evidence snippet from the source policy.
- SHA-256 content-hashed cache in `chrome.storage.local`; re-analysis is free
  unless the policy text has changed.
- Both Privacy Policy and Terms of Service are in scope.
- **BYOK** — you provide your own OpenAI API key. The extension talks to
  `api.openai.com` directly; there is no backend.

## Install (development)

1. Clone and open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → pick this directory.
4. Click the extension's gear icon → set your OpenAI API key.
5. Navigate to any site. Click the toolbar icon → **Analyze**.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (action, storage, scripting, activeTab) |
| `background.js` | Service worker; message router + orchestration |
| `lib/rules.js` | Deterministic red-flag / good-practice engine |
| `lib/schema.js` | Strict JSON schema for the LLM response |
| `lib/openai.js` | Responses API client (gpt-5.4, strict json_schema) |
| `lib/fetcher.js` | Fetch + HTML→text extraction when detect can't read the page itself |
| `lib/grader.js` | Hybrid grade orchestration + rule/LLM reconciliation |
| `lib/cache.js` | SHA-256 content-hash cache in `chrome.storage.local` |
| `rubric/*.json` | Versioned, auditable rubric — not hardcoded |
| `popup/*` | Grade card, evidence list, per-section breakdown |
| `options/*` | BYOK API key entry + cache manager |
| `tests/run-rules.mjs` | Node runner: rule-baseline regression against fixtures |
| `tests/fixtures/*` | Hand-graded policies for regression testing |

## Rubric

Six dimensions (sum to 100):

| Dimension | Weight |
|---|---|
| Data collection scope | 20 |
| Third-party sharing / selling | 25 |
| Retention & deletion rights | 20 |
| User rights (access, portability, opt-out) | 20 |
| Security & breach disclosure | 10 |
| Policy clarity / change-notification terms | 5 |

Bands: A ≥ 90, B 75–89, C 60–74, D 45–59, F < 45.

**Auto-F** (rule-based, non-overridable): explicit sale of personal data,
no deletion mechanism, retroactive changes without notice, unenumerated
"partners", no breach-notification commitment.

**Auto-cap at C:** mandatory arbitration + class-action waiver, no defined
retention period, vague "legitimate interest".

## Run the rule-baseline fixtures

```bash
node tests/run-rules.mjs
```

All fixtures should pass. Any rubric change must keep passing.

## Privacy

This is a privacy tool — ironic if it leaked data. So:

- No backend. No analytics. No telemetry.
- The extension sends policy text only to `api.openai.com` using *your* key.
- Your key lives in `chrome.storage.local` (per-device, never synced) and is
  sent only as the `Authorization` header to OpenAI.
- Caches are hashed by policy-text SHA-256 so re-analysis is free.

## Disclaimer

The grade is a **readability / user-friendliness score**, not a legal
compliance rating. Directional guidance, not legal advice.

## License

MIT © Ventz Petkov.

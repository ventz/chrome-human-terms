# Policy in Human Terms

A Chrome extension that translates a website's privacy policy or terms of
service into a scannable human summary with a letter grade (A–F), color-coded
severity, evidence quotes, and flagged red-flag clauses.

## Features

- Click the toolbar icon to open the side panel and analyze the current tab
  (or press ⌘⇧L / Ctrl+Shift+L). No background scanning.
- Auto-detects whether the current page IS a policy, or scrapes footer links
  to candidate Privacy/ToS/Cookie pages and lets you pick one.
- Sees through "Legal" hub pages that only list documents: the AI picks the
  real privacy policy or terms from the hub's links and grades that instead.
- **Hybrid grading:** deterministic rule engine (`rubric/red-flags.json`,
  `rubric/good-practices.json`) sets the baseline. OpenAI `gpt-6-sol` via the
  Responses API structures the summary and extracts evidence quotes. The LLM
  can *lower* the grade any amount but can only *raise* it by one letter, and
  cannot override `autoF` / `autoCapC` triggers.
- Every claim carries a quoted evidence snippet from the source policy. Model
  quotes that don't appear in the policy text are discarded.
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
5. Navigate to any site. Click the toolbar icon → **Analyze** in the side panel.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (action, side panel, storage, scripting, activeTab) |
| `background.js` | Service worker; message router + orchestration |
| `lib/rules.js` | Deterministic red-flag / good-practice engine |
| `lib/schema.js` | Strict JSON schema for the LLM response |
| `lib/openai.js` | Responses API client (gpt-6-sol, strict json_schema) |
| `lib/fetcher.js` | Fetch + HTML→text extraction when detect can't read the page itself |
| `lib/grader.js` | Hybrid grade orchestration + rule/LLM reconciliation |
| `lib/cache.js` | SHA-256 content-hash cache in `chrome.storage.local` |
| `rubric/*.json` | Versioned, auditable rubric — not hardcoded |
| `popup/popup.js` | Grade card, evidence list, per-section breakdown (loaded by the side panel) |
| `sidepanel/*` | Side panel shell opened from the toolbar icon |
| `report/*` | Full-tab report view |
| `options/*` | BYOK API key entry + cache manager |
| `tests/run-rules.mjs` | Node runner: fixture grades plus rule, quote, merge, and URL-safety regression checks |
| `tests/fixtures/*` | Synthetic policies with expected grades |

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
no deletion mechanism, retroactive changes without notice, no
breach-notification commitment. Red-flag rules ignore negated clauses, so
"we do not sell your data" does not trigger them.

**Auto-cap at C:** mandatory arbitration or a class-action waiver.

## Run the rule-baseline fixtures

```bash
node tests/run-rules.mjs
```

All checks should pass. Any rubric change must keep passing.

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

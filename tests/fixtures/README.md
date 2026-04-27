# Validation fixtures

Hand-graded real policies used as a regression corpus. Every rubric change must
re-run the fixtures and hit:

- ≥ 80% letter-grade agreement with the hand grade
- ≥ 95% agreement on `autoF` triggers

Each fixture is a directory with:

- `policy.txt` — raw policy text
- `expected.json` — `{ "grade": "A"|"B"|"C"|"D"|"F", "autoF": bool, "autoCapC": bool, "notes": "..." }`

## Seeds to add

1. **openai-privacy** — expect around B (data minimization, defined rights)
2. **stripe-privacy** — expect A/B (clear retention, portability)
3. **facebook-meta-privacy** — expect D (broad sharing, ad targeting)
4. **dark-pattern-synthetic** — expect F (synthetic policy with explicit sell-data + no deletion)
5. **tos-with-arbitration** — expect C cap (mandatory arbitration + class action waiver)

Run (future harness):

```bash
node tests/run-fixtures.mjs
```

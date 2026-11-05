# mc-question-v2 fixtures (ADR-0037)

Served Mission Control items (`IMissionAttentionItem` as `GET /api/mission-control` returns them), one per case the
question card must render. The web tests (`tests/unit/components/mission-question-card.test.tsx`) and the phone's
Flutter widget tests (purplemux-mobile story 32 copies this directory unchanged) read the same files.

| File | Case |
|---|---|
| `single.json` | `answerType: single`, a recommended option, evidence |
| `multi.json` | `answerType: multi`, several recommended |
| `confirm.json` | `answerType: confirm`, two options |
| `text.json` | `answerType: text`, no options |
| `action-done.json` | `answerType: action-done`, `kind: action` |
| `needs-text.json` | a `needsText` option |
| `long-context.json` | markdown context over 12 lines with links, a table, raw HTML that must not render, and `source` |
| `v1-item.json` | a v1 item (no `formatVersion`) with its `lint[]` |
| `revision-compatible.json` | `{ before, after }`: an option added and one relabelled; `after.changes.compatible` true |
| `revision-incompatible.json` | `{ before, after }`: the decision changed and an option was removed |

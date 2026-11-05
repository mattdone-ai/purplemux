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
| `so-proposal-open.json` | a fleet standing-order proposal (ADR-0041 §1 amendment D7): `confirm`, class `scope`, no default, nothing recommended, the order quoted in a code block; `proposal.state` `open` |
| `so-proposal-filed.json` | the same item answered Yes: `proposal` `{ state: filed, orderId: SO-12 }`; the card shows "Filed as SO-12" |
| `so-proposal-not-filed.json` | the same item answered Yes after the budget filled: `proposal.state` `not-filed` with the reason; the card shows "Not filed: <reason>" |

The `so-proposal-*` files were built with `buildProposalQuestion` (`src/lib/so-proposal.ts`), and
`tests/unit/components/mission-question-card.test.tsx` holds their question fields equal to its output, so the question
they hold is the one the server opens. Every other item serves `proposal: null`.

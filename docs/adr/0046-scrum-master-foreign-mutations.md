# ADR-0046: The selected Scrum Master may mutate the workspaces it manages

Amends [ADR-0021](0021-own-workspace-mutations.md) and [ADR-0029](0029-owner-grant-and-human-coordination-actions.md).
Status: accepted, 13 Nov 2026, on the owner's order: "Can you fix the purplemux permissions. Scrum master should
have complete control".

## Context

ADR-0021 confined every agent mutation to the caller's own workspace. ADR-0029 and ADR-0045 kept that rule for the
owner grant and for the human-saved Scrum Master selection: the selected manager tab could read every selected
workspace, but it could not send to, steer, close, restart or create a tab there.

On 13 Nov 2026 the Scrum Master seat moved from the Portfolio workspace to its own workspace. Its pull loop and relay
stopped with the old tab. The new seat could not close or message the 24 builder tabs it manages, and the relay
counted the refused sends as delivered. The owner then had to act in the UI for every tab.

## Decision

`authorizeWorkspaceMutation` (and so `authorizeWorkspace` for every non-read method, and `authorizeWorkspaceInput`)
admits a foreign mutation when, and only when, `selectedScrumMasterScope(scope, target)` answers a selection:

1. The caller holds a workspace token with a launch-verified tab identity.
2. The tab is the selection's exact `managerTabId` in its `managerWorkspaceId`, and is that workspace's current,
   live orchestrator (`currentCoordinator`).
3. The target workspace is in the selection's `workspaceIds`.
4. The selection is the newest one saved (a later save by any human replaces it at once).

The human saves the selection in the UI. That save is the consent: no agent can make itself the Scrum Master.

Each admitted foreign mutation writes one coordination-audit line, `event: "scrum-master-mutation-admitted"`, with the
manager workspace and tab, the target workspace and the route path (no query, no body). The line records the
authorization, not the outcome: the route can still refuse the request afterwards (400, 404, 409), and the line stays.
A route that excludes the Scrum Master (below) refuses before the check, so a refusal there writes no line. An audit
write that fails does not refuse the mutation. A selection store that cannot be read refuses it: the rule fails closed.

The routes the selection reaches are the tab routes: `tab send`, `steer`, `close` (DELETE), tab settings (PATCH),
`restart`, `probe`, `bg`, `tab create` and the agent launch routes. An audit `by` on a restart names the caller's own
workspace and tab, never the target workspace (follow-up review F2). A `bg` registration looks up the caller tab in the
caller's own workspace (F4).

## What does not change

- Peer entries, legacy drive grants, the owner grant and the global CLI token still authorize no foreign mutation.
- Mission Control writes (`mission events`, `mc ask`, question checks) stay own-workspace: a run binds to its own
  workspace's orchestrator. The Scrum Master reaches another workspace's owner questions by note, as before.
- A workspace's own reports stay own-workspace (follow-up review F3): `POST .../standup`, `POST .../flow`,
  `POST .../burndown`, `PUT` and `DELETE .../board-goal`, and experiment open, close and extend
  (`POST .../ledger/experiments`, `POST .../ledger/experiments/<id>`, `POST .../ledger/experiments/<id>/extend`). A
  foreign standup would replace the workspace's own, which drives phone alerts and the awaiting-human pause.
- Ledger producer tokens stay own-workspace (`POST .../ledger/tokens`, ADR-0033 §5, F1): an issue rotates the
  workspace's live token, and the token outlives the selection.
- Workspace settings stay own-workspace: `PATCH .../orchestration` and `PATCH .../directories` (ADR-0014).
- Each of these routes calls `authorizeOwnWorkspaceMutation` (through `authorizeOwnWorkspaceWrite` where the route also
  reads). A foreign caller, the selected Scrum Master included, gets 403 `forbidden` with `rule: "own-workspace-only"`
  and an error that names the surface. Reads of the same routes keep the read authority above.
- `canDriveWorkspace` / `driveDecision` stay token-only and synchronous.

## Consequences

- The Scrum Master can drain, wake, restart and close tabs in the workspaces it manages, without the owner.
- Text that the Scrum Master types into a worker is indistinguishable, inside that worker, from its own operator's
  text. ADR-0021 named this risk. The audit line, and the human's choice of exactly one manager tab, are the controls.
- Any tab in the manager workspace can `tab send` into the Scrum Master tab, and so steer mutations in every selected
  workspace (F6). The manager workspace holds only the Scrum Master seat, and that risk is accepted.
- Removing a workspace from the selection, or saving a selection with another manager, ends the authority at the next
  request.

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

Each admitted foreign mutation writes one coordination-audit line, `event: "scrum-master-mutation"`, with the manager
workspace and tab, the target workspace and the route path (no query, no body). An audit write that fails does not
refuse the mutation. A selection store that cannot be read refuses it: the rule fails closed.

## What does not change

- Peer entries, legacy drive grants, the owner grant and the global CLI token still authorize no foreign mutation.
- Mission Control writes (`mission events`, `mc ask`, question checks) stay own-workspace: a run binds to its own
  workspace's orchestrator. The Scrum Master reaches another workspace's owner questions by note, as before.
- `canDriveWorkspace` / `driveDecision` stay token-only and synchronous.

## Consequences

- The Scrum Master can drain, wake, restart and close tabs in the workspaces it manages, without the owner.
- Text that the Scrum Master types into a worker is indistinguishable, inside that worker, from its own operator's
  text. ADR-0021 named this risk. The audit line, and the human's choice of exactly one manager tab, are the controls.
- Removing a workspace from the selection, or saving a selection with another manager, ends the authority at the next
  request.

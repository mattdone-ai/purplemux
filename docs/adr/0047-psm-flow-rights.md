# ADR-0047: The Portfolio Scrum Master's flow rights: a host's callback URL, lease break, inbox retry, note show

Amends [ADR-0045](0045-scrum-master-limits-and-measured-tab-room.md) (the fleet-config writer rule) and
[ADR-0013](0013-notes-route-to-the-epic-owner.md) (who reads a note). Status: accepted, 14 Nov 2026, on the owner's order (ticket
PMUX-PSM-RIGHTS): "if you need to change the purplemux code then change it. I need you to have control to do what you
need to do", and "agents no. you yes you should have autonomy".

## Context

ADR-0045 and ADR-0046 gave the Portfolio Scrum Master's verified tab the limits and the tab routes of the workspaces it
manages. Four steps of its flow work still needed the admin token, so the owner had to run them:

1. Set a remote host's callback URL (`remote.callback-url.<host>`), so that the host's hooks post live instead of to
   the spool.
2. Break a lease whose holder is gone or stuck (`lease break`).
3. Retry a held notice in a workspace it manages (`inbox retry`).
4. Read a note sent to or from a workspace it manages (`note show`).

The order names one seat. Every other agent tab keeps the rights it had.

## Decision

The Scrum Master is the caller `scrumMasterSnapshot` answers for, as ADR-0045 and ADR-0046 define it: a workspace
token with a launch-verified tab, the current selection's exact manager tab, its workspace's live orchestrator, and
the newest selection saved. A builder seat, an orchestrator, a worker, an unverified tab and any other agent tab are
refused, each as before. The admin token keeps every right it had.

1. **`config set remote.callback-url.<host>`.** One more Scrum Master key form. The host must be on `remote.hosts` (the
   pool's remote hosts). The write needs a reason (1..500 characters) and the version it read, is checked inside the
   store lock against the selection, and is audited with role `portfolio-scrum-master`, as every ADR-0045 write.
   Because the key decides where a host's hooks post, each with its tab's token, the Scrum Master's value names the
   tailnet only:
   - `http(s)://<name>.<suffix>:<port>`, where `<name>` is one lower-case DNS label and `<suffix>` is the new
     admin-only key `remote.tailnet-suffix` (for example `example-net.ts.net`). With that key unset, no name is
     accepted. The key is never `ts.net` alone, which would admit a host of any tailnet. A suffix outside `ts.net`
     takes `https://` only: the check every writer passes refuses plain http to such a name.
   - `http(s)://<address in 100.64.0.0/10>:<port>`, the address in its one canonical spelling: four decimal octets,
     no leading zero (`100.064.0.1` is refused).

   The port is required, 1..65535; no user part, path or query. The check that every writer passes
   (`callbackUrlRefusal`) runs first, but the Scrum Master's check refuses every value outside these forms on its own.
   A refusal names its reason and is audited with the kind `outside-tailnet` or `unknown-host`. The admin token writes
   any value the general check takes, with no reason and no version, as before.
2. **`lease break NAME --reason TEXT`.** The Scrum Master breaks any lease with a reason of 1..500 characters. The
   release is audited as before, and its `by` carries the role and the selection.
3. **`inbox retry ID --reason TEXT`.** The Scrum Master retries a held notice whose target workspace is in its
   selection, with a reason of 1..500 characters (else 400 `reason-missing`). One coordination-audit line,
   `event: "inbox-retry"`, records the item, its target workspace, the reason, the role and the selection. An item
   outside the selection answers 404 `inbox-not-found`, as a missing one does. The target workspace, the note's
   sender and the admin token retry as before, with no reason.
4. **`note show ID`.** The Scrum Master reads a note whose recipient or sender workspace is in its selection. A read
   only: no ack, no point, no audit line.

Every reason above is counted one way (`actionReason`): trimmed, then 1..500 code points, for the fleet-config
writes, the lease break and the inbox retry alike.

Each write re-checks the selection inside its store lock, as ADR-0045 ruling 5 does for fleet config: the fleet
store for the callback URL, the lease lock for the break, the inbox lock for the retry. A selection that changed
between the Scrum Master proof and the lock refuses the action, and nothing is written (`forbidden` for the break,
403 `selection-changed` for the retry). The gap ADR-0045 states remains: a respawn of the manager tab between the proof
and the lock is not seen by the compare, which reads the selection only. A note show is a read and holds no lock.

## Why

The owner ordered it, for the Scrum Master alone. The value guard on the callback URL keeps the one new write that
redirects tokens on the tailnet: the suffix is the admin's to set, and an address outside 100.64.0.0/10 or a name
outside the suffix is refused. The other three rights act only on what already exists (a lease, a held notice, a
note) and stay inside the selection where a workspace is named.

## What does not change

`remote.hosts`, `remote.tailnet-suffix`, `remote.callback-url` (the fleet value), `remote.timeout-ms.*`, `pool.mode`,
the gate and build slots, the fleet cap, and every other admin-only key stay with the admin token. Like every
fleet-config rule, this is cooperative authority, not a security boundary (C-312 class): every agent can read the
admin token.

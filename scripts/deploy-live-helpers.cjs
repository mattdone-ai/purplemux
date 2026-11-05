#!/usr/bin/env node
// JSON and SQLite steps of scripts/deploy-live.sh. Pure functions are exported
// for the unit tests; the CLI below is what the shell script calls.

'use strict';

const fs = require('fs');
const path = require('path');

const AGENT_PANEL_TYPES = new Set(['claude-code', 'codex-cli', 'grok-cli']);

// b428f4d1 serves GET /api/cli/tabs without `cliState`; later servers always
// carry the key (null when unknown).
const listShape = (tabs) =>
  tabs.some((tab) => Object.prototype.hasOwnProperty.call(tab, 'cliState')) ? 'new' : 'old';

const agentTabs = (tabs) => tabs.filter((tab) => AGENT_PANEL_TYPES.has(tab.panelType));

const isExcluded = (tab, ownTabId, ignore) =>
  tab.tabId === ownTabId || ignore.includes(`${tab.workspaceId}/${tab.tabId}`);

const secondsSince = (at, now) => (typeof at === 'number' ? Math.max(0, Math.round((now - at) / 1000)) : null);

// The working predicate of ADR-0018 and story 38's is_working: busy after a stop is WAITING on
// background work, not mid-turn. A list without lastEvent (an older server) proves no stop.
const isWaiting = (tab) => tab.cliState === 'busy' && tab.lastEvent?.name === 'stop';

// busySince spans a whole chain of WAITING turns; a later prompt starts the current one (as fleet-status).
const turnStart = (tab) => {
  const prompt = tab.lastEvent?.name === 'prompt-submit' && typeof tab.lastEvent.at === 'number' ? tab.lastEvent.at : null;
  const stamps = [tab.busySince, prompt].filter((at) => typeof at === 'number');
  return stamps.length ? Math.max(...stamps) : null;
};

/**
 * Agent tabs that are mid-turn. New shape: `busy` and not WAITING. Old shape: the per-tab status
 * is the only state there is, so every `busy` counts, and a status that could not be read counts too.
 */
const midTurnTabs = ({ tabs, statuses, ownTabId, ignore, now }) => {
  const shape = listShape(tabs);
  const result = [];
  for (const tab of agentTabs(tabs)) {
    if (isExcluded(tab, ownTabId, ignore)) continue;
    const entry = { workspaceId: tab.workspaceId, tabId: tab.tabId, name: tab.name, busyForS: null };
    if (shape === 'new') {
      if (tab.cliState !== 'busy' || isWaiting(tab)) continue;
      result.push({ ...entry, busyForS: secondsSince(turnStart(tab), now), reason: 'busy' });
      continue;
    }
    const status = statuses[tab.tabId];
    if (status?.gone) continue;
    if (!status || status.error) {
      result.push({ ...entry, reason: `status unreadable: ${status?.error ?? 'missing'}` });
      continue;
    }
    if (status.cliState === 'busy') result.push({ ...entry, reason: 'busy' });
  }
  return result;
};

/** New-shape agent tabs the quiet wait treats as quiet only because they are WAITING, for the listing. */
const waitingTabs = ({ tabs, ownTabId, ignore, now }) => {
  if (listShape(tabs) !== 'new') return [];
  return agentTabs(tabs)
    .filter((tab) => !isExcluded(tab, ownTabId, ignore) && isWaiting(tab))
    .map((tab) => ({ workspaceId: tab.workspaceId, tabId: tab.tabId, name: tab.name, waitingForS: secondsSince(tab.lastEvent.at, now) }));
};

const formatSeconds = (s) => (s === null ? 'unknown' : `${s}s`);

const pickWorkspaceToken = (tabs, tokens) => {
  const withTabs = [...new Set(tabs.map((tab) => tab.workspaceId))].find((id) => tokens[id]);
  const workspaceId = withTabs ?? Object.keys(tokens)[0];
  return workspaceId ? { workspaceId, token: tokens[workspaceId] } : null;
};

// The live server keeps most rows in the WAL, so a plain copy of the main file
// loses them; the backup API reads through the WAL.
const backupSqlite = async (src, dst, modulePath) => {
  const Database = require(modulePath);
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dst);
  } finally {
    db.close();
  }
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

const readStatuses = (dir) => {
  const statuses = {};
  if (!dir || !fs.existsSync(dir)) return statuses;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) statuses[name.slice(0, -5)] = readJson(path.join(dir, name));
  }
  return statuses;
};

const readQuietInput = ([file, statusDir, ownTabId, ...ignore]) => ({
  tabs: readJson(file).tabs ?? [],
  statuses: readStatuses(statusDir),
  ownTabId: ownTabId || null,
  ignore,
  now: Date.now(),
});

/**
 * Delivery progress of a `deploy status --json` body: a notice is settled once it is delivered,
 * held (it waits for a person), dropped (its tab closed) or pruned; only queued ones are pending.
 */
const announceProgress = (status) => {
  const recipients = Array.isArray(status?.recipients) ? status.recipients : [];
  const delivered = recipients.filter((r) => r.state === 'delivered').length;
  const settled = recipients.filter((r) => r.state !== 'queued').length;
  return { delivered, settled, total: recipients.length };
};

const commands = {
  // shape TABS_JSON -> new|old
  shape: ([file]) => console.log(listShape(readJson(file).tabs ?? [])),
  // agent-tabs TABS_JSON -> "ws<TAB>tab" per agent tab
  'agent-tabs': ([file]) => {
    for (const tab of agentTabs(readJson(file).tabs ?? [])) console.log(`${tab.workspaceId}\t${tab.tabId}`);
  },
  // midturn TABS_JSON STATUS_DIR OWN_TAB [WS/TAB...] -> "ws<TAB>tab<TAB>name<TAB>busy-for<TAB>reason"
  midturn: (args) => {
    for (const row of midTurnTabs(readQuietInput(args))) {
      console.log([row.workspaceId, row.tabId, row.name, formatSeconds(row.busyForS), row.reason].join('\t'));
    }
  },
  // waiting TABS_JSON STATUS_DIR OWN_TAB [WS/TAB...] -> "ws<TAB>tab<TAB>name<TAB>waiting-for"
  waiting: (args) => {
    for (const row of waitingTabs(readQuietInput(args))) {
      console.log([row.workspaceId, row.tabId, row.name, formatSeconds(row.waitingForS)].join('\t'));
    }
  },
  // ws-token TABS_JSON TOKENS_JSON -> "ws<TAB>token" or nothing
  'ws-token': ([tabsFile, tokensFile]) => {
    const tokens = fs.existsSync(tokensFile) ? readJson(tokensFile) : {};
    const picked = pickWorkspaceToken(readJson(tabsFile).tabs ?? [], tokens);
    if (picked) console.log(`${picked.workspaceId}\t${picked.token}`);
  },
  // field JSON_FILE KEY -> the top-level value, or nothing
  field: ([file, key]) => {
    try {
      const value = readJson(file)[key];
      if (value !== undefined && value !== null) console.log(String(value));
    } catch {
      // not JSON: print nothing
    }
  },
  // announce-progress STATUS_JSON -> "delivered settled" (0 0 when unreadable: nothing settled)
  'announce-progress': ([file]) => {
    let status = null;
    try {
      status = readJson(file);
    } catch {
      // unreadable: nothing settled
    }
    const { delivered, settled } = announceProgress(status);
    console.log(`${delivered} ${settled}`);
  },
  // count JSON_FILE KEY -> the length of the top-level array KEY (0 when absent or unreadable)
  count: ([file, key]) => {
    try {
      const value = readJson(file)[key];
      console.log(Array.isArray(value) ? value.length : 0);
    } catch {
      console.log(0);
    }
  },
  // backup SRC DST BETTER_SQLITE3_MODULE
  backup: ([src, dst, modulePath]) => backupSqlite(src, dst, modulePath),
};

if (require.main === module) {
  const [name, ...args] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    process.stderr.write(`usage: deploy-live-helpers.cjs ${Object.keys(commands).join('|')} ...\n`);
    process.exit(2);
  }
  Promise.resolve()
    .then(() => command(args))
    .catch((err) => {
      process.stderr.write(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

module.exports = { listShape, agentTabs, midTurnTabs, waitingTabs, pickWorkspaceToken, backupSqlite, announceProgress };

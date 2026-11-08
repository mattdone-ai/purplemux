'use strict';

// The command groups bin/cli.js handles. bin/purplemux.js — the installed entry
// point that ~/.local/bin/purplemux resolves to — dispatches to cli.js only for
// these names and answers `unknown command` for anything else, so a group that
// is added to cli.js but not here does not exist for any caller.
// tests/unit/bin/cli-commands.test.ts holds this set equal to the top-level
// `case` labels of cli.js main().
const CLI_COMMANDS = new Set([
  'workspaces',
  'workspace',
  'tab',
  'orchestration',
  'standup',
  'burndown',
  'flow',
  'spend',
  'board',
  'ledger',
  'events',
  'effects',
  'mission',
  'mc',
  'portfolio',
  'owner',
  'lease',
  'pool',
  'curator',
  'inbox',
  'note',
  'event',
  'config',
  'grant',
  'deploy',
  'watch',
  'handoff',
  'wait',
  'so',
  'api-guide',
  'help',
  '-h',
  '--help',
]);

module.exports = { CLI_COMMANDS };

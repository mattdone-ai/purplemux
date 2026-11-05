import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const DATA_DIR_DOC = fs.readFileSync(path.resolve('docs/DATA-DIR.md'), 'utf-8');

// Every store the server writes under ~/.purplemux. A story that adds a store adds it here and
// documents it in docs/DATA-DIR.md in the same commit (architecture §4.11).
const STORES = [
  'config.json', 'workspaces.json', 'layout.json', 'message-history.json', 'claude-prompt.md', 'codex-prompt.md',
  'standups.json', 'burndown.json', 'flow.json', 'liveness.json', 'session-history.json', 'session-tabs.json',
  'owner-grants.json', 'grants.json', 'leases.json', 'notes.json', 'watches.json', 'inbox.json', 'fleet-config.json',
  'deploy-announcements.json', 'tab-tokens.json', 'workspace-tokens.json', 'mission-control.sqlite',
  'orchestrator-presence.json', 'evaluator/', 'bin/evaluator-sql', 'bin/evaluator-chrome-mcp', 'bin/evaluator-mcp-filter.cjs', 'audit/coordination.jsonl', 'session-stats/', 'hook-spool/', 'remote-transcripts/',
  'stats/', 'spend-index.json', 'ledger.sqlite', 'ledger-tokens.json', 'ledger-tokens/', 'ledger-spool/', 'standing-orders.md', 'standing-orders-seq.json',
];

/** A store is named as a whole code span (`` `flow.json` ``) or a whole tree entry (`── flow.json `), never as a prefix. */
const missingStores = (doc: string): string =>
  `missing=[${STORES.filter((store) => !doc.includes(`\`${store}\``) && !doc.includes(`── ${store} `)).join(', ')}]`;

// The coordination audit lines that epic purplemux-flow added (architecture §4.11), each with its source.
const EPIC_AUDIT_EVENTS: Array<[event: string, source: string]> = [
  ['tab-over-cap', 'src/lib/tab-cap.ts'],
  ['tab-restart', 'src/lib/tab-restart.ts'],
  ['owner-read', 'src/lib/grant-service.ts'],
  ['owner-note', 'src/lib/notes-service.ts'],
  ['attention-auto-answer', 'src/lib/mission-control-auto-answer-tick.ts'],
];

const auditSection = (doc: string): string => {
  const start = doc.indexOf('### `audit/coordination.jsonl`');
  const end = doc.indexOf('\n### ', start + 1);
  return start < 0 ? '' : doc.slice(start, end < 0 ? undefined : end);
};

describe('docs/DATA-DIR.md', () => {
  it('names every audit line the epic added, in the coordination audit section', () => {
    const section = auditSection(DATA_DIR_DOC);
    const notWritten = EPIC_AUDIT_EVENTS
      .filter(([event, source]) => !fs.readFileSync(path.resolve(source), 'utf-8').includes(`event: '${event}'`))
      .map(([event]) => event);
    const undocumented = EPIC_AUDIT_EVENTS.filter(([event]) => !section.includes(`\`${event}\``)).map(([event]) => event);
    expect(`notWritten=[${notWritten.join(', ')}] undocumented=[${undocumented.join(', ')}]`).toBe('notWritten=[] undocumented=[]');
    expect(section).toContain('`breakReason`');
    expect(section).toContain('{human: <session subject>}');
  });


  it('names every store under ~/.purplemux in the tree or in a code span', () => {
    expect(missingStores(DATA_DIR_DOC)).toBe('missing=[]');
  });

  it('does not take a longer name for a store', () => {
    const withoutFlow = DATA_DIR_DOC
      .split('\n')
      .filter((line) => !line.includes('── flow.json '))
      .join('\n')
      .replaceAll('`flow.json`', 'the record');
    expect(withoutFlow).toContain('`flow.json.corrupt-<receivedAt>`');
    expect(missingStores(withoutFlow)).toBe('missing=[flow.json]');
  });

  it('states the stats cache version that stats-cache.ts writes', () => {
    const source = fs.readFileSync(path.resolve('src/lib/stats/stats-cache.ts'), 'utf-8');
    const code = source.match(/^const CACHE_VERSION = (\d+);$/m)?.[1];
    const documented = DATA_DIR_DOC.match(/Cache version `(\d+)` \(`CACHE_VERSION` in `stats-cache\.ts`\)/)?.[1];
    expect(code).toBeDefined();
    expect(documented).toBe(code);
  });
});

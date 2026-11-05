// The labelling pass's input (story 16 AC 4): candidate ids with their text, written to a private scratch
// directory for the one-time Opus 5.5 labelling pass, then deleted. The labelled sets keep ids and labels only.
//   tsx scripts/curator/extract-candidates.ts <scratch-dir>
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { endingAsksSomething } from '@/lib/curator-tasks';
import { readMissionAsks, transcriptTurnEnds, workspaceTranscripts, workspacesRoot } from '@/lib/curator-sources';
import { readMessageHistory } from '@/lib/message-history-store';
import { extractTurnMarker } from '@/lib/turn-end';

const TURN_ENDINGS_WORKSPACE = 'ws-ldhziO';
const TURN_ENDINGS = 500;
const PERMISSION_QUESTIONS = 200;
const BATCH = 100;
const PERMISSION_ASK = /\b(shall i|should i|want me to|do you want|ok to|okay to|go ahead|may i|can i|permission|approve|approval|proceed\?|green light|sign[- ]off)\b/i;

const order = (id: string): string => createHash('sha256').update(`hfl-16:${id}`).digest('hex');

const writeBatches = async (dir: string, name: string, items: Array<{ id: string; text: string }>): Promise<number> => {
  let n = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    n += 1;
    await fs.writeFile(path.join(dir, `${name}-${String(n).padStart(2, '0')}.json`), JSON.stringify(items.slice(i, i + BATCH), null, 1), { mode: 0o600 });
  }
  return n;
};

const main = async (): Promise<void> => {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: extract-candidates.ts <scratch-dir>');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const workspaces = (await fs.readdir(workspacesRoot(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  const owner: Array<{ id: string; text: string; at: string }> = [];
  for (const ws of workspaces) {
    for (const entry of await readMessageHistory(ws)) owner.push({ id: `${ws}/${entry.id}`, text: entry.message, at: entry.sentAt });
  }
  owner.sort((a, b) => a.at.localeCompare(b.at));

  const unmarked = async (ws: string) => {
    const out: Array<{ id: string; text: string }> = [];
    const seen = new Set<string>();
    for (const file of await workspaceTranscripts(ws)) {
      for (const turn of await transcriptTurnEnds(ws, file)) {
        if (extractTurnMarker(turn.text) || seen.has(turn.text)) continue;
        seen.add(turn.text);
        out.push({ id: turn.id, text: turn.text });
      }
    }
    return out.sort((a, b) => order(a.id).localeCompare(order(b.id)));
  };

  // flag-owner-question sees only endings that pass its '?' pre-filter, so the set is drawn from those.
  const turnEndings = (await unmarked(TURN_ENDINGS_WORKSPACE)).filter((t) => endingAsksSomething(t.text)).slice(0, TURN_ENDINGS);
  const asks: Array<{ id: string; text: string }> = [];
  for (const ws of workspaces) asks.push(...(await unmarked(ws)).filter((t) => PERMISSION_ASK.test(t.text)));
  // An ask an agent opened in Mission Control for the owner's approval, or a decision worded as a permission ask.
  for (const ask of readMissionAsks(null)) {
    if (ask.humanNeed === 'approval' || ask.humanNeed === 'decision' || PERMISSION_ASK.test(ask.text)) asks.push({ id: `${ask.workspaceId}/mc/${ask.id}`, text: ask.text });
  }
  asks.sort((a, b) => order(a.id).localeCompare(order(b.id)));

  const counts = {
    owner: [owner.length, await writeBatches(dir, 'owner', owner.map(({ id, text }) => ({ id, text })))],
    turnEndings: [turnEndings.length, await writeBatches(dir, 'turn', turnEndings)],
    permissionCandidates: [asks.length, await writeBatches(dir, 'perm', asks.slice(0, PERMISSION_QUESTIONS * 3))],
  };
  process.stdout.write(`${JSON.stringify(counts)}\n`);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

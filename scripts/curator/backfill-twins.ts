// One-time (story 16 round 2; consult 16-promote-gate, ruling 3): give every labelled item its source time `at`, and
// every owner message its transcript twin `alt`, while the history entries still exist. Writes ids, times, offsets and
// hashes only.
//   tsx scripts/curator/backfill-twins.ts
import { findTwin, readMissionAsks, transcriptTurnEnds, transcriptUserEntries, workspaceTranscripts } from '@/lib/curator-sources';
import { readLabelledSet, writeLabelledSet, type ILabelledItem } from '@/lib/curator-store';
import { readMessageHistory } from '@/lib/message-history-store';

const main = async (): Promise<void> => {
  const counts: Record<string, number> = {};
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

  const owner = (await readLabelledSet('classify-owner-message'))!;
  const byWorkspace = new Map<string, ILabelledItem[]>();
  for (const item of owner.items) {
    const ws = item.id.split('/')[0];
    byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), item]);
  }
  for (const [ws, items] of byWorkspace) {
    const history = new Map((await readMessageHistory(ws)).map((e) => [e.id, e]));
    const entries = (await Promise.all((await workspaceTranscripts(ws)).map((file) => transcriptUserEntries(ws, file)))).flat();
    for (const item of items) {
      const entry = history.get(item.id.split('/')[1]);
      if (!entry) { bump('owner-history-gone'); continue; }
      item.at = Date.parse(entry.sentAt);
      const twin = findTwin(entry.message, item.at, entries);
      if (twin) { item.alt = twin; bump(`owner-twin-${twin.mode}`); } else bump(`owner-no-twin-${item.label}`);
    }
  }
  await writeLabelledSet(owner);

  const turns = (await readLabelledSet('flag-owner-question'))!;
  const turnAt = new Map<string, number>();
  for (const file of await workspaceTranscripts('ws-ldhziO')) for (const t of await transcriptTurnEnds('ws-ldhziO', file)) turnAt.set(t.id, t.at);
  const asks = new Map(readMissionAsks(null).map((a) => [`${a.workspaceId}/mc/${a.id}`, a.createdAt]));
  const timeOf = async (id: string): Promise<number | undefined> => {
    if (id.includes('/mc/')) return asks.get(id);
    if (turnAt.has(id)) return turnAt.get(id);
    const ws = id.split('/')[0];
    for (const file of (await workspaceTranscripts(ws)).filter((f) => f.endsWith(`${id.split('/')[1]}.jsonl`))) {
      for (const t of await transcriptTurnEnds(ws, file)) turnAt.set(t.id, t.at);
    }
    return turnAt.get(id);
  };
  for (const set of [turns, (await readLabelledSet('match-standing-order'))!]) {
    for (const item of set.items) {
      const at = await timeOf(item.id);
      if (at) { item.at = at; bump(`${set.task}-at`); } else bump(`${set.task}-no-source`);
    }
    await writeLabelledSet(set);
  }
  process.stdout.write(`${JSON.stringify(counts)}\n`);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

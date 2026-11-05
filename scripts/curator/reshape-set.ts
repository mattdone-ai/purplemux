// The reshape gate's set (story 23 AC 4): historical Mission Control items whose question fails the format-2 check and
// that a wording-only reshape could fix, by id only. The database is opened read-only; the set holds no question text.
//   tsx scripts/curator/reshape-set.ts [path/to/mission-control.sqlite]
// The set is written under the running HOME's ~/.purplemux/curator/eval/, so an isolated instance builds its own.
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { SPOT_CHECK_ITEM_PREFIX } from '@/lib/curator-spot-check';
import { FILED_ORDER_ITEM_PREFIX } from '@/lib/curator-filed-order';
import { liftDraft, structuralDefects } from '@/lib/curator-reshape';
import { writeReshapeSet } from '@/lib/curator-store';
import { validateMissionQuestion } from '@/lib/mission-question-format';
import { looksLikeSecret } from '@/lib/secret-patterns';

/** Why a historical item is left out of the set, or null when it is in. */
export const reshapeCandidate = (id: string, questionJson: string): string | null => {
  if (id.startsWith(SPOT_CHECK_ITEM_PREFIX) || id.startsWith(FILED_ORDER_ITEM_PREFIX)) return 'curator item';
  if (looksLikeSecret(questionJson)) return 'credential-shaped';
  let question: unknown;
  try {
    question = JSON.parse(questionJson);
  } catch {
    return 'not JSON';
  }
  if (validateMissionQuestion(question, 2).ok) return 'already valid';
  const draft = liftDraft(question);
  if (!draft) return 'not a draft';
  return structuralDefects(draft).length ? 'structure' : null;
};

const main = async (): Promise<void> => {
  const file = process.argv[2] ?? path.join(os.homedir(), '.purplemux', 'mission-control.sqlite');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const rows = db.prepare('SELECT id, workspace_id, question_json, created_at FROM attention_items ORDER BY created_at, id')
    .all() as Array<{ id: string; workspace_id: string; question_json: string; created_at: number }>;
  db.close();
  const left: Record<string, number> = {};
  const items: Array<{ id: string; at: number }> = [];
  for (const row of rows) {
    const why = reshapeCandidate(row.id, row.question_json);
    if (why) left[why] = (left[why] ?? 0) + 1;
    else items.push({ id: `${row.workspace_id}/mc/${row.id}`, at: row.created_at });
  }
  await writeReshapeSet({ task: 'reshape-question', builtBy: 'scripts/curator/reshape-set.ts', builtAt: new Date().toISOString(), items });
  process.stdout.write(`${JSON.stringify({ read: rows.length, inSet: items.length, leftOut: left })}\n`);
};

if (process.argv[1]?.endsWith('reshape-set.ts')) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

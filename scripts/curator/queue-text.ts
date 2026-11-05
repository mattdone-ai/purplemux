// The label pass's input for a queue (consult 16-promote-gate, ruling 1): each queued id with its text, as one JSON
// array on stdout for the Opus 5.5 labeller. It writes no file (review r2 F3): there is nothing to delete afterwards.
//   tsx scripts/curator/queue-text.ts <task>
import { curatorQueueTexts } from '@/lib/curator-service';
import { isCuratorTask, isLabelTask } from '@/lib/curator-tasks';

const main = async (): Promise<void> => {
  const [task] = process.argv.slice(2);
  if (!isCuratorTask(task) || !isLabelTask(task)) throw new Error('usage: queue-text.ts <classifier task>');
  process.stdout.write(`${JSON.stringify(await curatorQueueTexts(task))}\n`);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

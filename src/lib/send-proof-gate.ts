/**
 * The per-tab gate a `tab send` holds while it waits for proof of its submission (vel-RETRO-R3, CONFIRM r2).
 *
 * The send types inside the tab's dispatch lock (`withCodexTargetLock`), then releases that lock before it waits:
 * a live Codex hook is applied inside the same lock, so a proof wait under it would lock out the proof itself. This
 * gate keeps every other dispatch out for the window instead. Every dispatch takes it before the dispatch lock
 * (`withAgentDispatchLock`, the cookie send route); no hook and no lifecycle step takes it. The order is always gate,
 * then lock, so a gate holder never waits for a gate.
 */

const g = globalThis as unknown as { __ptSendProofGates?: Map<string, Promise<void>> };

const gates = (): Map<string, Promise<void>> => {
  g.__ptSendProofGates ??= new Map();
  return g.__ptSendProofGates;
};

export const withSendProofGate = async <T>(workspaceId: string, tabId: string, work: () => Promise<T>): Promise<T> => {
  const key = `${workspaceId}\u0000${tabId}`;
  const previous = gates().get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  gates().set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (gates().get(key) === current) gates().delete(key);
  }
};

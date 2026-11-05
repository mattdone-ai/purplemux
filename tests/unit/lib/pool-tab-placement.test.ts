import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { AUTO_PLACE_TIMEOUT_MS, resolveAutoHost } = await import('@/lib/pool-tab-placement');

const deps = (over: Partial<Parameters<typeof resolveAutoHost>[1]> = {}) => ({
  place: vi.fn(async () => ({ ok: true as const, host: 'ai-lan', local: false, reason: 'most free memory' })),
  cwdOnHost: vi.fn(async () => true),
  localName: () => 'mdserver1',
  ...over,
});

describe('resolveAutoHost (ADR-0039 §4)', () => {
  it('a remote placement is the host to create on; the cwd is checked there', async () => {
    const d = deps();
    expect(await resolveAutoHost({ panelType: 'claude-code', cwd: '/home/mdone/pool/x' }, d)).toEqual({
      host: 'ai-lan', cwdChecked: true, placement: { host: 'ai-lan', local: false, reason: 'most free memory', fallback: false },
    });
    expect(d.cwdOnHost).toHaveBeenCalledWith('ai-lan', '/home/mdone/pool/x');
  });

  it('no pool answer in 2 s places the tab here', async () => {
    vi.useFakeTimers();
    try {
      const pending = resolveAutoHost({ panelType: 'claude-code' }, deps({ place: vi.fn(() => new Promise<never>(() => {})) }));
      await vi.advanceTimersByTimeAsync(AUTO_PLACE_TIMEOUT_MS);
      expect(await pending).toEqual({
        host: undefined, placement: { host: 'mdserver1', local: true, reason: 'fallback: no pool answer in 2000 ms', fallback: true },
      });
      expect(AUTO_PLACE_TIMEOUT_MS).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cwd check that fails over ssh places the tab here and names the ssh failure, never "not a directory" (r2 F4)', async () => {
    const out = await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, deps({ cwdOnHost: vi.fn(async () => { throw new Error('remote host ai-lan did not answer over ssh (timed out)'); }) }));
    expect(out).toMatchObject({ host: undefined, placement: { local: true, fallback: true } });
    expect(out.placement.reason).toBe('fallback: ai-lan did not answer: remote host ai-lan did not answer over ssh (timed out) (pool chose it: most free memory)');
    expect(out.placement.reason).not.toContain('not a directory');
  });

  it('a cwd proven on the chosen host is marked checked; no cwd is not', async () => {
    expect(await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, deps())).toMatchObject({ host: 'ai-lan', cwdChecked: true });
    expect(await resolveAutoHost({ panelType: 'claude-code' }, deps())).toMatchObject({ host: 'ai-lan', cwdChecked: false });
  });

  it('a role goes to the pool with the request', async () => {
    const d = deps();
    await resolveAutoHost({ panelType: 'claude-code', role: 'evaluator' }, d);
    expect(d.place).toHaveBeenCalledWith({ kind: 'tab', memGb: 0, panelType: 'claude-code', role: 'evaluator' });
  });
});

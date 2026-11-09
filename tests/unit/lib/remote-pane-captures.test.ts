import { describe, expect, it, vi } from 'vitest';
import { RemotePaneCaptures } from '@/lib/remote-pane-captures';
import { parseRemoteCaptures } from '@/lib/remote-host';

// vel-PMX-FU: the readiness probe's remote captures are batched per host, read once, fresh only, and never awaited.

const make = (capture: (host: string, sessions: readonly string[]) => Promise<Map<string, string | null>>) => {
  let now = 1_000_000;
  const onFailure = vi.fn();
  const captures = new RemotePaneCaptures({ capture: vi.fn(capture), now: () => now, maxAgeMs: () => 60_000, onFailure });
  return { captures, onFailure, advance: (ms: number) => { now += ms; } };
};

describe('RemotePaneCaptures', () => {
  it('batches every asked-for pane of a host into one capture, per host, and gives each answer once', async () => {
    const calls: Array<[string, string[]]> = [];
    const { captures } = make(async (host, sessions) => {
      calls.push([host, [...sessions]]);
      return new Map(sessions.map((s) => [s, `screen of ${s}`]));
    });
    expect(captures.take('s1')).toBeUndefined();
    captures.request('host-a', 's1');
    captures.request('host-a', 's2');
    captures.request('host-b', 's3');
    await captures.flush();
    expect(calls).toEqual([['host-a', ['s1', 's2']], ['host-b', ['s3']]]);
    expect(captures.take('s2')).toBe('screen of s2');
    expect(captures.take('s2')).toBeUndefined();
  });

  it('a pane tmux could not capture answers null; an answer older than maxAge is not given', async () => {
    const { captures, advance } = make(async () => new Map<string, string | null>([['s1', null], ['s2', 'x']]));
    captures.request('host-a', 's1');
    captures.request('host-a', 's2');
    await captures.flush();
    expect(captures.take('s1')).toBeNull();
    advance(60_001);
    expect(captures.take('s2')).toBeUndefined();
  });

  it('a failed capture backs its host off 30 s; a host with a capture running starts no second one', async () => {
    let release: (m: Map<string, string | null>) => void = () => {};
    let fail = true;
    const capture = vi.fn(async () => {
      if (fail) throw new Error('ssh exit 255');
      return new Promise<Map<string, string | null>>((resolve) => { release = resolve; });
    });
    const { captures, onFailure, advance } = make(capture);
    captures.request('host-a', 's1');
    await captures.flush();
    expect(onFailure).toHaveBeenCalledWith('host-a', 'ssh exit 255');
    captures.request('host-a', 's1');
    await captures.flush();
    expect(capture).toHaveBeenCalledTimes(1);
    advance(30_000);
    fail = false;
    void captures.flush();
    captures.request('host-a', 's2');
    void captures.flush();
    expect(capture).toHaveBeenCalledTimes(2);
    release(new Map([['s1', 'a']]));
    await captures.settled();
    expect(captures.take('s1')).toBe('a');
  });

  it('forget drops a pane\'s answer and its request', async () => {
    const capture = vi.fn(async (_h: string, sessions: readonly string[]) => new Map(sessions.map((s) => [s, 'x'] as [string, string])));
    const { captures } = make(capture);
    captures.request('host-a', 's1');
    captures.forget('s1');
    await captures.flush();
    expect(capture).toHaveBeenCalledWith('host-a', []);
    expect(captures.take('s1')).toBeUndefined();
  });
});

describe('parseRemoteCaptures', () => {
  it('reads ok and gone panes and needs the end line', () => {
    const out = 'n1 ok pt-a\nline one\n\nline three\nn1 gone pt-b\nn1 ok pt-c\nn1 end\n';
    expect(parseRemoteCaptures(out, 'n1')).toEqual(new Map([['pt-a', 'line one\n\nline three\n'], ['pt-b', null], ['pt-c', '\n']]));
    expect(parseRemoteCaptures('n1 ok pt-a\nhalf', 'n1')).toBeNull();
  });

  it('a pane line that only looks like a header for another nonce is pane text', () => {
    expect(parseRemoteCaptures('n1 ok pt-a\nn2 end\nn2 gone pt-x\nn1 end\n', 'n1')).toEqual(new Map([['pt-a', 'n2 end\nn2 gone pt-x\n']]));
  });
});

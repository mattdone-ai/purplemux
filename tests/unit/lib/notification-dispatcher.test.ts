import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDispatcher,
  createStatusSocketChannel,
  createWebPushChannel,
} from '@/lib/notification-dispatcher';
import type { INotificationChannel } from '@/lib/notification-dispatcher';
import type { IPushSubscriptionRecord } from '@/lib/push-subscriptions';
import { alertFor } from '@/lib/alert-policy';
import type { IAlert } from '@/types/status';

const AT = 1_700_000_000_000;

const draft = (overrides: Partial<Parameters<typeof alertFor>[0]> = {}) =>
  alertFor({
    kind: 'needs-input',
    tabId: 'T1',
    workspaceId: 'ws-1',
    workspaceName: 'Epic',
    tabName: 'orchestrator',
    providerId: 'claude',
    isOrchestrator: true,
    at: AT,
    lastUserMessage: 'run the migration',
    ...overrides,
  });

const fakeChannel = (name: string) => {
  const delivered: IAlert[] = [];
  const channel: INotificationChannel = {
    name,
    deliver: (alert) => { delivered.push(alert); },
  };
  return { channel, delivered };
};

const record = (endpoint: string, deviceId?: string): IPushSubscriptionRecord => ({
  subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
  deviceId,
  createdAt: 0,
});

describe('NotificationDispatcher', () => {
  it('fans one alert out to every registered channel', async () => {
    const dispatcher = new NotificationDispatcher();
    const a = fakeChannel('a');
    const b = fakeChannel('b');
    dispatcher.register(a.channel);
    dispatcher.register(b.channel);

    const alert = await dispatcher.dispatch(draft());

    expect(a.delivered).toEqual([alert]);
    expect(b.delivered).toEqual([alert]);
    expect(alert.kind).toBe('needs-input');
    expect(alert.title).toBe('Input Required');
  });

  it('stamps a unique id and a monotonic seq on every alert', async () => {
    const dispatcher = new NotificationDispatcher();
    const first = await dispatcher.dispatch(draft());
    const second = await dispatcher.dispatch(draft({ kind: 'review' }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toBeTruthy();
  });

  it('replaces a channel registered under the same name', async () => {
    const dispatcher = new NotificationDispatcher();
    const first = fakeChannel('web-push');
    const second = fakeChannel('web-push');
    dispatcher.register(first.channel);
    dispatcher.register(second.channel);

    await dispatcher.dispatch(draft());

    expect(dispatcher.channelNames()).toEqual(['web-push']);
    expect(first.delivered).toHaveLength(0);
    expect(second.delivered).toHaveLength(1);
  });

  it('keeps delivering when one channel throws', async () => {
    const dispatcher = new NotificationDispatcher();
    const ok = fakeChannel('ok');
    dispatcher.register({ name: 'boom', deliver: () => { throw new Error('down'); } });
    dispatcher.register(ok.channel);

    await expect(dispatcher.dispatch(draft())).resolves.toBeTruthy();
    expect(ok.delivered).toHaveLength(1);
  });

  it('passes the delivery context through to the channel', async () => {
    const dispatcher = new NotificationDispatcher();
    const deliver = vi.fn();
    dispatcher.register({ name: 'spy', deliver });

    await dispatcher.dispatch(draft(), { agentSessionId: 'sess-1', workspaceDir: '/tmp/epic' });

    expect(deliver.mock.calls[0][1]).toEqual({ agentSessionId: 'sess-1', workspaceDir: '/tmp/epic' });
  });
});

describe('createStatusSocketChannel', () => {
  it('broadcasts the alert as a notification:alert frame', async () => {
    const frames: unknown[] = [];
    const dispatcher = new NotificationDispatcher();
    dispatcher.register(createStatusSocketChannel((frame) => { frames.push(frame); }));

    const alert = await dispatcher.dispatch(draft({ kind: 'standup-needs-human', headline: 'blocked on schema' }));

    expect(frames).toEqual([{ type: 'notification:alert', alert }]);
    expect(alert.body).toBe('blocked on schema');
  });
});

describe('kind flag (ADR-0032)', () => {
  const flagDraft = () => draft({
    kind: 'flag',
    tabId: 'T2',
    tabName: 'worker',
    isOrchestrator: false,
    detail: 'worker: busy with no activity for 37 min',
    flag: { source: 'fleet', rule: 'stall', subject: 'T2', text: 'busy with no activity for 37 min' },
  });

  it('fans a flag alert out to every channel with its flag object, title and body', async () => {
    const dispatcher = new NotificationDispatcher();
    const a = fakeChannel('status-socket');
    const b = fakeChannel('web-push');
    dispatcher.register(a.channel);
    dispatcher.register(b.channel);

    const alert = await dispatcher.dispatch(flagDraft());

    expect(a.delivered).toEqual([alert]);
    expect(b.delivered).toEqual([alert]);
    expect(alert).toMatchObject({
      kind: 'flag',
      tabId: 'T2',
      isOrchestrator: false,
      title: 'Flag Raised',
      body: 'worker: busy with no activity for 37 min',
      flag: { source: 'fleet', rule: 'stall', subject: 'T2', text: 'busy with no activity for 37 min' },
    });
  });

  it('puts the flag on a flag alert only: another kind given one carries none', () => {
    expect(draft({ kind: 'review', flag: { source: 'flow', rule: 'stale', subject: 'ws-1', text: 'x' } })).not.toHaveProperty('flag');
    expect(draft({ kind: 'flag', flag: { source: 'flow', rule: 'stale', subject: 'ws-1', text: 'no publish for 11 min' } }).body)
      .toBe('no publish for 11 min');
  });
});

describe('kind attention-opened', () => {
  it('fans the alert out with its itemId, the fixed title and the item title as body', async () => {
    const dispatcher = new NotificationDispatcher();
    const a = fakeChannel('status-socket');
    dispatcher.register(a.channel);

    const alert = await dispatcher.dispatch(draft({ kind: 'attention-opened', itemId: 'item-7', itemTitle: ' Approve the BC go-live? ' }));

    expect(a.delivered).toEqual([alert]);
    expect(alert).toMatchObject({ kind: 'attention-opened', itemId: 'item-7', title: 'Mission Control: answer needed', body: 'Approve the BC go-live?' });
  });

  it('puts the itemId on an attention-opened alert only', () => {
    expect(draft({ kind: 'review', itemId: 'item-7' })).not.toHaveProperty('itemId');
    expect(draft({ kind: 'attention-opened' })).not.toHaveProperty('itemId');
  });
});

describe('createWebPushChannel', () => {
  const setup = (records: IPushSubscriptionRecord[], visible: string[] = []) => {
    const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
    const dropped: string[] = [];
    const channel = createWebPushChannel({
      listRecords: async () => records,
      configureVapid: async () => {},
      send: async (subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      },
      drop: async (endpoint) => { dropped.push(endpoint); },
      isDeviceVisible: (deviceId) => visible.includes(deviceId),
      isAnyDeviceVisible: () => visible.length > 0,
    });
    return { channel, sent, dropped };
  };

  const dispatched = (): IAlert => ({ ...draft(), id: 'alert-1', seq: 7 });

  it('suppresses only the subscriptions bound to a visible device', async () => {
    const { channel, sent } = setup([record('https://push/desktop', 'D1'), record('https://push/phone', 'D2')], ['D1']);

    await channel.deliver(dispatched(), {});

    expect(sent.map((s) => s.endpoint)).toEqual(['https://push/phone']);
  });

  it('sends to every bound device when none is visible', async () => {
    const { channel, sent } = setup([record('https://push/desktop', 'D1'), record('https://push/phone', 'D2')]);

    await channel.deliver(dispatched(), {});

    expect(sent.map((s) => s.endpoint)).toEqual(['https://push/desktop', 'https://push/phone']);
  });

  it('falls back to the global gate for unbound legacy subscriptions', async () => {
    const visibleElsewhere = setup([record('https://push/legacy')], ['D1']);
    await visibleElsewhere.channel.deliver(dispatched(), {});
    expect(visibleElsewhere.sent).toHaveLength(0);

    const nothingVisible = setup([record('https://push/legacy')]);
    await nothingVisible.channel.deliver(dispatched(), {});
    expect(nothingVisible.sent).toHaveLength(1);
  });

  it('carries the existing payload shape plus the additive alert fields', async () => {
    const { channel, sent } = setup([record('https://push/phone', 'D2')]);

    await channel.deliver(dispatched(), { agentSessionId: 'sess-1', workspaceDir: '/tmp/epic' });

    expect(sent[0].payload).toEqual({
      title: 'Input Required',
      body: 'run the migration',
      tabId: 'T1',
      workspaceId: 'ws-1',
      providerId: 'claude',
      claudeSessionId: 'sess-1',
      agentSessionId: 'sess-1',
      workspaceName: 'Epic',
      workspaceDir: '/tmp/epic',
      kind: 'needs-input',
      isOrchestrator: true,
      alertId: 'alert-1',
    });
  });

  it('adds the flag object to a flag alert\'s payload, and nothing to other kinds', async () => {
    const { channel, sent } = setup([record('https://push/phone', 'D2')]);
    const flag = { source: 'flow' as const, rule: 'queue-long', subject: 'landing', text: 'landing holds 12 items (threshold 10)' };

    await channel.deliver({ ...draft({ kind: 'flag', flag }), id: 'alert-2', seq: 8 }, {});
    await channel.deliver(dispatched(), {});

    expect(sent[0].payload).toMatchObject({ kind: 'flag', flag, body: 'landing holds 12 items (threshold 10)' });
    expect(sent[1].payload).not.toHaveProperty('flag');
  });

  it('adds the itemId to an attention-opened alert\'s payload, and nothing to other kinds', async () => {
    const { channel, sent } = setup([record('https://push/phone', 'D2')]);

    await channel.deliver({ ...draft({ kind: 'attention-opened', itemId: 'item-7', itemTitle: 'Approve?' }), id: 'alert-3', seq: 9 }, {});
    await channel.deliver(dispatched(), {});

    expect(sent[0].payload).toMatchObject({ kind: 'attention-opened', itemId: 'item-7', title: 'Mission Control: answer needed', body: 'Approve?' });
    expect(sent[1].payload).not.toHaveProperty('itemId');
  });

  it('leaves the question summary out of the Web Push payload: nothing reads it there (story 33 R4)', async () => {
    const { channel, sent } = setup([record('https://push/phone', 'D2')]);
    const question = {
      formatVersion: 2 as const, decision: 'Ship?', answerType: 'confirm' as const, revision: 3,
      options: [{ id: 'yes', label: 'Yes', needsText: false }, { id: 'no', label: 'No', needsText: false }],
    };

    await channel.deliver({ ...draft({ kind: 'attention-opened', itemId: 'item-7', question }), id: 'alert-4', seq: 10 }, {});

    expect(sent[0].payload).toMatchObject({ itemId: 'item-7' });
    expect(sent[0].payload).not.toHaveProperty('question');
  });

  it('reaps subscriptions the push service reports as gone', async () => {
    const records = [record('https://push/gone', 'D1'), record('https://push/live', 'D2')];
    const dropped: string[] = [];
    const sent: string[] = [];
    const channel = createWebPushChannel({
      listRecords: async () => records,
      configureVapid: async () => {},
      send: async (subscription) => {
        if (subscription.endpoint === 'https://push/gone') {
          throw Object.assign(new Error('gone'), { statusCode: 410 });
        }
        sent.push(subscription.endpoint);
      },
      drop: async (endpoint) => { dropped.push(endpoint); },
      isDeviceVisible: () => false,
      isAnyDeviceVisible: () => false,
    });

    await channel.deliver(dispatched(), {});

    expect(dropped).toEqual(['https://push/gone']);
    expect(sent).toEqual(['https://push/live']);
  });

  it('keeps a subscription that failed for a transient reason', async () => {
    const dropped: string[] = [];
    const channel = createWebPushChannel({
      listRecords: async () => [record('https://push/flaky', 'D1')],
      configureVapid: async () => {},
      send: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); },
      drop: async (endpoint) => { dropped.push(endpoint); },
      isDeviceVisible: () => false,
      isAnyDeviceVisible: () => false,
    });

    await channel.deliver(dispatched(), {});

    expect(dropped).toEqual([]);
  });

  it('does no VAPID work when nothing is subscribed', async () => {
    const configureVapid = vi.fn(async () => {});
    const channel = createWebPushChannel({
      listRecords: async () => [],
      configureVapid,
      send: async () => {},
      drop: async () => {},
      isDeviceVisible: () => false,
      isAnyDeviceVisible: () => false,
    });

    await channel.deliver(dispatched(), {});

    expect(configureVapid).not.toHaveBeenCalled();
  });
});

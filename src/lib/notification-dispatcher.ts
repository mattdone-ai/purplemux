import webpush from 'web-push';
import { nanoid } from 'nanoid';
import type { PushSubscription } from 'web-push';
import { getSubscriptionRecords, removeSubscription, isDeviceVisible, isAnyDeviceVisible } from '@/lib/push-subscriptions';
import type { IPushSubscriptionRecord } from '@/lib/push-subscriptions';
import { getVAPIDKeys } from '@/lib/vapid-keys';
import { createLogger } from '@/lib/logger';
import type { TAlertDraft } from '@/lib/alert-policy';
import type { IAlert, INotificationAlertMessage } from '@/types/status';

const log = createLogger('alerts');

/** Extra per-alert data a channel may need but that never crosses the status socket. */
export interface IAlertContext {
  agentSessionId?: string | null;
  workspaceDir?: string | null;
}

export interface INotificationChannel {
  name: string;
  deliver: (alert: IAlert, ctx: IAlertContext) => void | Promise<void>;
}

export class NotificationDispatcher {
  private channels: INotificationChannel[] = [];
  private seq = 0;

  register(channel: INotificationChannel): void {
    const idx = this.channels.findIndex((c) => c.name === channel.name);
    if (idx >= 0) {
      this.channels[idx] = channel;
    } else {
      this.channels.push(channel);
    }
  }

  has(name: string): boolean {
    return this.channels.some((c) => c.name === name);
  }

  channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  async dispatch(draft: TAlertDraft, ctx: IAlertContext = {}): Promise<IAlert> {
    const alert: IAlert = { ...draft, id: nanoid(8), seq: ++this.seq };
    for (const channel of this.channels) {
      try {
        await channel.deliver(alert, ctx);
      } catch (err) {
        log.warn(`alert channel ${channel.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    log.info({ kind: alert.kind, tabId: alert.tabId, seq: alert.seq, ...(alert.itemId ? { itemId: alert.itemId } : {}) }, 'alert dispatched');
    return alert;
  }
}

export const createStatusSocketChannel = (
  broadcast: (frame: INotificationAlertMessage) => void,
): INotificationChannel => ({
  name: 'status-socket',
  deliver: (alert) => {
    broadcast({ type: 'notification:alert', alert });
  },
});

export interface IWebPushChannelDeps {
  listRecords: () => Promise<IPushSubscriptionRecord[]>;
  configureVapid: () => Promise<void>;
  send: (subscription: PushSubscription, payload: string) => Promise<void>;
  drop: (endpoint: string) => Promise<void>;
  isDeviceVisible: (deviceId: string) => boolean;
  isAnyDeviceVisible: () => boolean;
}

const defaultWebPushDeps: IWebPushChannelDeps = {
  listRecords: getSubscriptionRecords,
  configureVapid: async () => {
    const keys = await getVAPIDKeys();
    webpush.setVapidDetails('mailto:noreply@purplemux.app', keys.publicKey, keys.privateKey);
  },
  send: async (subscription, payload) => {
    await webpush.sendNotification(subscription, payload);
  },
  drop: removeSubscription,
  isDeviceVisible,
  isAnyDeviceVisible,
};

const buildPushPayload = (alert: IAlert, ctx: IAlertContext): string =>
  JSON.stringify({
    title: alert.title,
    body: alert.body,
    tabId: alert.tabId,
    workspaceId: alert.workspaceId,
    providerId: alert.providerId,
    // Field name kept `claudeSessionId` for SW back-compat: existing service workers
    // (public/sw.js) read this key and a brief stale-SW window during upgrade would
    // break notifications if renamed. `agentSessionId` is the name new clients read.
    claudeSessionId: ctx.agentSessionId ?? null,
    agentSessionId: ctx.agentSessionId ?? null,
    workspaceName: alert.workspaceName,
    workspaceDir: ctx.workspaceDir ?? null,
    kind: alert.kind,
    isOrchestrator: alert.isOrchestrator,
    alertId: alert.id,
    ...(alert.flag ? { flag: alert.flag } : {}),
    ...(alert.itemId ? { itemId: alert.itemId } : {}),
  });

export const createWebPushChannel = (overrides: Partial<IWebPushChannelDeps> = {}): INotificationChannel => {
  const deps = { ...defaultWebPushDeps, ...overrides };

  return {
    name: 'web-push',
    deliver: async (alert, ctx) => {
      const records = await deps.listRecords();
      if (records.length === 0) return;

      // A subscription with no device binding predates the record migration, so
      // it keeps the old global gate; bound ones are muted only by their own device.
      const targets = records.filter((r) => (
        r.deviceId ? !deps.isDeviceVisible(r.deviceId) : !deps.isAnyDeviceVisible()
      ));
      if (targets.length === 0) return;

      await deps.configureVapid();
      const payload = buildPushPayload(alert, ctx);

      for (const target of targets) {
        try {
          await deps.send(target.subscription, payload);
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 410 || status === 404) {
            await deps.drop(target.subscription.endpoint);
          }
          log.warn('Web push send error: %s', status);
        }
      }
    },
  };
};

const g = globalThis as unknown as { __ptNotificationDispatcher?: NotificationDispatcher };

export const getNotificationDispatcher = (): NotificationDispatcher => {
  if (!g.__ptNotificationDispatcher) g.__ptNotificationDispatcher = new NotificationDispatcher();
  return g.__ptNotificationDispatcher;
};

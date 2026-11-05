import { createAccessTokenProvider, loadServiceAccount } from '@/lib/fcm-auth';
import type { TFcmFetch } from '@/lib/fcm-auth';
import { createLogger } from '@/lib/logger';
import type { IAlertContext, INotificationChannel, NotificationDispatcher } from '@/lib/notification-dispatcher';
import {
  getFcmSubscriptionRecords,
  isAnyDeviceVisible,
  isDeviceVisible,
  removeFcmSubscription,
} from '@/lib/push-subscriptions';
import type { IFcmSubscriptionRecord } from '@/lib/push-subscriptions';
import type { IAlert } from '@/types/status';

const log = createLogger('alerts');

const SEND_HOST = 'https://fcm.googleapis.com/v1/projects';
const SERVICE_ACCOUNT_ENV = 'FCM_SERVICE_ACCOUNT_PATH';
const REAPABLE_ERROR_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT']);

/** FCM's data payload limit (4096 bytes); a map over it is never sent, so a size refusal can never reap a device. */
export const FCM_DATA_LIMIT_BYTES = 4_096;
/** The budget the optional question summary must fit under, with headroom for the envelope (story 33 R5). */
export const FCM_DATA_BUDGET_BYTES = 3_584;
/** A size refusal names the message, not the registration (FCM answers it as INVALID_ARGUMENT too). */
const SIZE_REFUSAL = /too big|too large|exceeds?|size/i;

/** The data map's size as sent: its JSON in UTF-8 bytes, which counts every escape and multi-byte character. */
export const fcmDataBytes = (data: Record<string, string>): number => Buffer.byteLength(JSON.stringify(data), 'utf8');

export interface IFcmMessage {
  message: {
    token: string;
    data: Record<string, string>;
    android: { priority: 'high' | 'normal' };
  };
}

export interface IFcmChannelDeps {
  projectId: string;
  listRecords: () => Promise<IFcmSubscriptionRecord[]>;
  accessToken: () => Promise<string>;
  fetchImpl: TFcmFetch;
  drop: (token: string) => Promise<void>;
  isDeviceVisible: (deviceId: string) => boolean;
  isAnyDeviceVisible: () => boolean;
}

/**
 * Data-only by construction: an FCM `notification` block would be rendered by
 * Play services itself, which drops the app's alert kinds, inline actions and
 * deep link. Every value is a string because that is all an FCM data map holds.
 */
export const buildFcmMessage = (alert: IAlert, ctx: IAlertContext, token: string): IFcmMessage => {
  const data: Record<string, string> = {
    id: alert.id,
    seq: String(alert.seq),
    kind: alert.kind,
    tabId: alert.tabId,
    workspaceId: alert.workspaceId,
    workspaceName: alert.workspaceName,
    tabName: alert.tabName,
    providerId: alert.providerId,
    isOrchestrator: String(alert.isOrchestrator),
    title: alert.title,
    body: alert.body,
    at: String(alert.at),
  };
  // The flag text is already the body; the structured field carries what routes the tap.
  if (alert.flag) data.flag = JSON.stringify({ source: alert.flag.source, rule: alert.flag.rule, subject: alert.flag.subject });
  if (alert.itemId) data.itemId = alert.itemId;
  if (ctx.agentSessionId) data.agentSessionId = ctx.agentSessionId;
  if (ctx.workspaceDir) data.workspaceDir = ctx.workspaceDir;
  // A v2 question is bounded by its schema; a v1 one is not, so only v2 rides the data map, and only
  // while the whole map stays under the budget in UTF-8 bytes. Without it the phone opens the item.
  if (alert.question?.formatVersion === 2) {
    const question = JSON.stringify(alert.question);
    if (fcmDataBytes({ ...data, question }) <= FCM_DATA_BUDGET_BYTES) data.question = question;
    else log.info({ itemId: alert.itemId }, 'FCM: question summary left out, over the data budget');
  }

  return {
    message: {
      token,
      data,
      android: { priority: alert.kind === 'needs-input' || alert.kind === 'attention-opened' ? 'high' : 'normal' },
    },
  };
};

const errorDetails = (body: unknown): unknown[] => {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  return Array.isArray(details) ? details : [];
};

/**
 * The field paths of a `google.rpc.BadRequest` detail, or null when the
 * response is not one.
 *
 * FCM answers INVALID_ARGUMENT both for a dead registration token and for a
 * message it cannot parse, and only the second carries `fieldViolations`. The
 * two must not be conflated: reaping on our own malformed message would
 * unsubscribe every device on the first dispatch, silently and all at once,
 * where a dead token reaped one dispatch late costs a single wasted send.
 */
export const payloadViolationFields = (body: unknown): string[] | null => {
  let fields: string[] | null = null;
  for (const detail of errorDetails(body)) {
    const violations = (detail as { fieldViolations?: unknown })?.fieldViolations;
    if (!Array.isArray(violations)) continue;
    fields ??= [];
    for (const violation of violations) {
      const field = (violation as { field?: unknown })?.field;
      if (typeof field === 'string' && field) fields.push(field);
    }
  }
  return fields;
};

export const isReapableFcmError = (body: unknown): boolean => {
  if (payloadViolationFields(body) !== null) return false;
  const error = (body as { error?: { status?: unknown; message?: unknown } } | null)?.error;
  if (!error) return false;
  if (typeof error.message === 'string' && SIZE_REFUSAL.test(error.message)) return false;
  if (typeof error.status === 'string' && REAPABLE_ERROR_CODES.has(error.status)) return true;
  return errorDetails(body).some((detail) => {
    const code = (detail as { errorCode?: unknown })?.errorCode;
    return typeof code === 'string' && REAPABLE_ERROR_CODES.has(code);
  });
};

export const createFcmChannel = (deps: IFcmChannelDeps): INotificationChannel => {
  const url = `${SEND_HOST}/${deps.projectId}/messages:send`;

  return {
    name: 'fcm',
    deliver: async (alert, ctx) => {
      const records = await deps.listRecords();
      if (records.length === 0) return;

      // Same gate as Web Push: a bound registration is muted only by its own
      // device, an unbound one keeps the old global rule.
      const targets = records.filter((r) => (
        r.deviceId ? !deps.isDeviceVisible(r.deviceId) : !deps.isAnyDeviceVisible()
      ));
      if (targets.length === 0) return;

      const accessToken = await deps.accessToken();

      for (const target of targets) {
        const message = buildFcmMessage(alert, ctx, target.token);
        if (fcmDataBytes(message.message.data) > FCM_DATA_LIMIT_BYTES) {
          // Never sent: FCM would refuse it as INVALID_ARGUMENT, which must not cost the device its registration.
          log.warn(`FCM: alert ${alert.id} data map over ${FCM_DATA_LIMIT_BYTES} bytes, not sent`);
          continue;
        }
        try {
          const res = await deps.fetchImpl(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(message),
          });
          if (res.ok) continue;

          const body = await res.json().catch(() => null);
          const violations = payloadViolationFields(body);
          if (violations) {
            log.error(
              `FCM rejected the message shape (${res.status}), not the registration — no token reaped. `
              + `Fix the payload: ${violations.join(', ') || 'field unspecified'}`,
            );
          } else if (isReapableFcmError(body)) {
            await deps.drop(target.token);
            log.info('FCM registration reaped after %s', res.status);
          } else {
            log.warn('FCM send error: %s', res.status);
          }
        } catch (err) {
          log.warn(`FCM send failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
  };
};

export const createFcmChannelFromEnv = (): INotificationChannel | null => {
  const filePath = process.env[SERVICE_ACCOUNT_ENV];
  if (!filePath) {
    log.info(`FCM channel disabled: ${SERVICE_ACCOUNT_ENV} is not set`);
    return null;
  }

  const loaded = loadServiceAccount(filePath);
  if (!loaded.ok) {
    log.warn(`FCM channel disabled: service account at ${SERVICE_ACCOUNT_ENV} is ${loaded.reason}`);
    return null;
  }

  const accessToken = createAccessTokenProvider(loaded.account);
  log.info(`FCM channel enabled for project ${loaded.account.projectId}`);

  return createFcmChannel({
    projectId: loaded.account.projectId,
    listRecords: getFcmSubscriptionRecords,
    accessToken,
    fetchImpl: (url, init) => fetch(url, init),
    drop: removeFcmSubscription,
    isDeviceVisible,
    isAnyDeviceVisible,
  });
};

export const registerFcmChannel = (dispatcher: NotificationDispatcher): boolean => {
  const channel = createFcmChannelFromEnv();
  if (!channel) return false;
  dispatcher.register(channel);
  return true;
};

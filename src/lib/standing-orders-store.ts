import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SEED_FLEET_ORDERS } from '@/lib/standing-orders-seed';
import {
  STANDING_ORDERS_MAX_BYTES,
  STANDING_ORDER_ID,
  StandingOrderError,
  checkOrderInput,
  checkStrikeReason,
  orderNumber,
  parseOrderFile,
  renderOrderFile,
  renderPromptSection,
  sectionBytes,
  type IOrderInput,
  type IStandingOrder,
  type IStandingOrderFile,
} from '@/lib/standing-orders';

// The files (ADR-0041): `~/.purplemux/standing-orders.md` for the fleet and
// `~/.purplemux/workspaces/<ws>/standing-orders.md` per workspace. Ids are unique across all of them,
// so `SO-<n>` names one order wherever it is cited. One lock serialises every write on the host.

export const FLEET = 'fleet';
const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]{1,32}$/;

const g = globalThis as unknown as { __ptStandingOrdersLock?: Promise<void> };
if (!g.__ptStandingOrdersLock) g.__ptStandingOrdersLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptStandingOrdersLock!;
  g.__ptStandingOrdersLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const baseDir = (): string => path.join(os.homedir(), '.purplemux');

export const orderFilePath = (owner: string): string => (owner === FLEET
  ? path.join(baseDir(), 'standing-orders.md')
  : path.join(baseDir(), 'workspaces', owner, 'standing-orders.md'));

export const isOrderOwner = (owner: string): boolean => owner === FLEET || WORKSPACE_ID.test(owner);

/** tmp + rename with a name of its own: two writers never share a tmp file (review r1, R3). */
const writeAtomic = async (target: string, body: string): Promise<void> => {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

const write = (file: IStandingOrderFile): Promise<void> => writeAtomic(orderFilePath(file.owner), renderOrderFile(file));

type TRead = { file: IStandingOrderFile } | { absent: true };

const readRaw = async (owner: string): Promise<TRead> => {
  const file = orderFilePath(owner);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    throw new StandingOrderError('so-unreadable', `${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  return { file: parseOrderFile(raw, owner, file) };
};

/** Under the lock: an absent fleet file is seeded, once, whoever reads first. */
const readOrderFileLocked = async (owner: string): Promise<IStandingOrderFile> => {
  const read = await readRaw(owner);
  if ('file' in read) return read.file;
  if (owner !== FLEET) return { owner, orders: [] };
  const seeded = { owner, orders: SEED_FLEET_ORDERS.map((order) => ({ ...order })) };
  await write(seeded);
  return seeded;
};

/**
 * One owner's file. An absent workspace file holds no orders; an absent fleet file is seeded with the
 * W8 orders once (story 14 AC 3), so a host that never had one starts with them. The seed is written
 * under the host lock: the first start reads the fleet file once per workspace, all at once.
 */
export const readOrderFile = async (owner: string): Promise<IStandingOrderFile> => {
  const read = await readRaw(owner);
  if ('file' in read) return read.file;
  if (owner !== FLEET) return { owner, orders: [] };
  return withLock(() => readOrderFileLocked(owner));
};

/**
 * The highest id ever handed out, kept beside the fleet file: an order whose file went with its workspace
 * directory still holds its number (review r1, R5). Absent before the first add.
 */
export const orderSeqPath = (): string => path.join(baseDir(), 'standing-orders-seq.json');

const readHighWater = async (): Promise<number> => {
  let raw: string;
  try {
    raw = await fs.readFile(orderSeqPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new StandingOrderError('so-unreadable', `${orderSeqPath()}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  let parsed: { high?: unknown } | null;
  try {
    parsed = JSON.parse(raw) as { high?: unknown } | null;
  } catch {
    // No self-repair: the ids on disk alone could hand out a number again (confirm NIT 3).
    throw new StandingOrderError('so-unreadable', `${orderSeqPath()}: not JSON; repair or restore it before adding an order`);
  }
  const high = parsed?.high;
  if (!Number.isSafeInteger(high) || (high as number) < 0) throw new StandingOrderError('so-unreadable', `${orderSeqPath()}: no whole "high"`);
  return high as number;
};

const workspaceOwners = async (): Promise<string[]> => {
  const entries = await fs.readdir(path.join(baseDir(), 'workspaces'), { withFileTypes: true }).catch(() => []);
  const owners: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
    const exists = await fs.access(orderFilePath(entry.name)).then(() => true, () => false);
    if (exists) owners.push(entry.name);
  }
  return owners.sort();
};

/** Every file on the host: the fleet first, then each workspace that has one. */
export const readAllOrderFiles = async (): Promise<IStandingOrderFile[]> => {
  const owners = [FLEET, ...await workspaceOwners()];
  return Promise.all(owners.map(readOrderFile));
};

/** The same, for a caller that already holds the lock (an add or a strike). */
const readAllOrderFilesLocked = async (): Promise<IStandingOrderFile[]> => {
  const owners = [FLEET, ...await workspaceOwners()];
  return Promise.all(owners.map(readOrderFileLocked));
};

/** The prompt section one workspace's tabs load; a file that cannot be read is said, never silently dropped. */
export const promptSectionFor = async (workspaceId: string): Promise<string> => {
  try {
    const [fleet, own] = await Promise.all([readOrderFile(FLEET), readOrderFile(workspaceId)]);
    return renderPromptSection(fleet.orders, own.orders);
  } catch (err) {
    return `## Standing orders\n\nThe standing orders could not be read (${err instanceof Error ? err.message : String(err)}). Run \`purplemux so list\` before you ask the owner anything.\n`;
  }
};

/** The workspaces whose prompt a change of `owner`'s file reaches. */
const reachedWorkspaces = async (owner: string, known: readonly string[]): Promise<string[]> =>
  (owner === FLEET ? [...new Set([...known, ...await workspaceOwners()])] : [owner]);

export interface IOrderChange {
  owner: string;
  order: IStandingOrder;
  /** The largest prompt section the change leaves, in bytes, and the workspace it is for. */
  bytes: number;
  workspaceId: string | null;
}

/**
 * At most 8 KB of standing orders reach any one workspace's prompt (ADR-HFL-05 decision 4): an add that
 * would pass it is refused with the measured size. `knownWorkspaces` are the workspaces the fleet reaches.
 */
export const addOrder = (owner: string, input: IOrderInput, knownWorkspaces: readonly string[], now: number): Promise<IOrderChange> =>
  withLock(async () => {
    if (!isOrderOwner(owner)) throw new StandingOrderError('so-invalid', `an order belongs to the fleet or a workspace id ws-…, got ${JSON.stringify(owner)}`);
    const fields = checkOrderInput(input, owner);
    const files = await readAllOrderFilesLocked();
    const mine = files.find((file) => file.owner === owner) ?? await readOrderFileLocked(owner);
    const next = Math.max(await readHighWater(), ...files.flatMap((file) => file.orders.map((order) => orderNumber(order.id)))) + 1;
    const order: IStandingOrder = { id: `SO-${next}`, ...fields, state: 'active', added: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') };
    const updated = { owner, orders: [...mine.orders, order] };
    const fleet = owner === FLEET ? updated : files[0];
    let largest = { bytes: owner === FLEET ? sectionBytes(fleet.orders, []) : 0, workspaceId: null as string | null };
    for (const ws of await reachedWorkspaces(owner, knownWorkspaces)) {
      const own = ws === owner ? updated : files.find((file) => file.owner === ws) ?? { owner: ws, orders: [] };
      const bytes = sectionBytes(fleet.orders, own.orders);
      if (bytes > largest.bytes) largest = { bytes, workspaceId: ws };
    }
    if (largest.bytes > STANDING_ORDERS_MAX_BYTES) {
      throw new StandingOrderError('so-too-large',
        `standing orders for ${largest.workspaceId ?? 'the fleet'} would be ${largest.bytes} bytes, at most ${STANDING_ORDERS_MAX_BYTES}: strike an order or shorten this one`);
    }
    await writeAtomic(orderSeqPath(), JSON.stringify({ high: next }));
    await write(updated);
    return { owner, order, ...largest };
  });

/** Find an order by id in any file; the caller holds the lock. */
const findOrderLocked = async (id: string): Promise<{ owner: string; order: IStandingOrder } | null> => {
  if (!STANDING_ORDER_ID.test(id)) throw new StandingOrderError('so-invalid', `an order id is SO-<n>, got ${JSON.stringify(id)}`);
  for (const file of await readAllOrderFilesLocked()) {
    const order = file.orders.find((o) => o.id === id);
    if (order) return { owner: file.owner, order };
  }
  return null;
};

/** Strike an active order; the entry stays in its file with the time and the reason. */
export const strikeOrder = (id: string, reason: unknown, mayChange: (owner: string) => void, now: number): Promise<IOrderChange> =>
  withLock(async () => {
    const why = checkStrikeReason(reason);
    const found = await findOrderLocked(id);
    if (!found) throw new StandingOrderError('so-not-found', `no standing order ${id}`);
    mayChange(found.owner);
    if (found.order.state === 'struck') throw new StandingOrderError('so-struck', `${id} is already struck (${found.order.struck})`);
    const file = await readOrderFileLocked(found.owner);
    const order: IStandingOrder = { ...found.order, state: 'struck', struck: `${new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')} — ${why}` };
    await write({ ...file, orders: file.orders.map((o) => (o.id === id ? order : o)) });
    return { owner: found.owner, order, bytes: 0, workspaceId: null };
  });

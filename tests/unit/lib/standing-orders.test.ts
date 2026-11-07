import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { ITabEventRoute } from '@/lib/tab-event-router';

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/config-store', () => ({ getDangerouslySkipPermissions: vi.fn(async () => false) }));

const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);
const caller = (workspaceId: string | null, admin = false): ICaller =>
  ({ scope: {}, workspaceId, tabId: workspaceId ? 'tab-x' : null, tabName: null, verified: true, admin } as unknown as ICaller);
const ADMIN = caller(null, true);

const lib = async () => ({
  ...await import('@/lib/standing-orders'),
  ...await import('@/lib/standing-orders-store'),
  ...await import('@/lib/standing-orders-service'),
  seed: (await import('@/lib/standing-orders-seed')).SEED_FLEET_ORDERS,
});

const errorCode = async (p: Promise<unknown>): Promise<string> => p.then(() => 'none', (err: { code?: string }) => err.code ?? String(err));

class Fanout {
  prompts: string[] = [];
  routed: ITabEventRoute[] = [];
  tabs = [{ workspaceId: 'ws-a', tabId: 'tab-a1' }, { workspaceId: 'ws-a', tabId: 'tab-a2' }, { workspaceId: 'ws-b', tabId: 'tab-b1' }];
  deps() {
    return {
      now: () => T0,
      workspaceIds: async () => ['ws-a', 'ws-b'],
      refreshPrompt: async (ws: string) => { this.prompts.push(ws); },
      liveAgentTabs: (ws: string | null) => this.tabs.filter((t) => ws === null || t.workspaceId === ws),
      route: async (event: ITabEventRoute) => {
        this.routed.push(event);
        return { class: event.class, delivered: true, seq: this.routed.length, duplicate: false };
      },
    };
  }
}

beforeEach(async () => {
  vi.resetModules();
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-so-'));
  delete (globalThis as { __ptStandingOrdersLock?: unknown }).__ptStandingOrdersLock;
});

afterEach(async () => {
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('the seed fleet file (story 14 AC 3)', () => {
  it('is written once, with the seven W8 orders of ADR-HFL-05 decision 4, each with its owner message id and UTC date', async () => {
    const { readOrderFile, orderFilePath, seed } = await lib();
    const fleet = await readOrderFile('fleet');
    expect(fleet.orders.map((o) => o.id)).toEqual(['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5', 'SO-6', 'SO-7']);
    expect(fleet.orders).toEqual(seed);
    for (const order of fleet.orders) {
      expect(order.source).toMatch(/^owner messages? ws-[A-Za-z0-9_]+\/[A-Za-z0-9_-]{21}/);
      expect(order.source).toMatch(/\b2026-1[01]-\d\dT\d\d:\d\dZ\b/);
      expect(order.state).toBe('active');
    }
    const topics = [/v1 sources and tests/, /not available.*Redash, Billing, v1/, /Access already granted/,
      /Reversible work needs no approval\. Dev and QA are not production/, /tailnet.*AEDT/, /Mission Control/, /board show --line.*board URL/];
    topics.forEach((topic, i) => expect(fleet.orders[i].text).toMatch(topic));
    const written = await fs.readFile(orderFilePath('fleet'), 'utf-8');
    expect(written).toContain('## SO-1\n- text: Before you build or change a slice');
    expect((await fs.stat(orderFilePath('fleet'))).mode & 0o777).toBe(0o600);
    // An existing file is never re-seeded: what the owner struck stays struck.
    await fs.writeFile(orderFilePath('fleet'), written.replace('- state: active', '- state: struck'));
    expect((await readOrderFile('fleet')).orders[0].state).toBe('struck');
  });
});

describe('seed SO-6 says exactly what the harness does with a NEEDS-DECISION line (confirm NIT 2, C8)', () => {
  it('is the architect\'s text, character for character', async () => {
    const { seed } = await lib();
    expect(seed.find((o) => o.id === 'SO-6')?.text).toBe("Questions for the owner go to Mission Control, never only into chat. End the turn on one line: NEEDS-DECISION: [money|irreversible|scope|bookkeeping] <question> (a) <option> (b) <option>. The tag and the options are optional. The harness opens the Mission Control item from that line: do not open a second item for it. While you wait, repeat the same line without changes; a reworded line revises your open item. A different question opens its own item only with the marker: NEEDS-DECISION: [new] <question>. If no item can open, the harness tells the orchestrator to open it; a workspace with no orchestrator gets a push to the owner's devices instead.");
  });
});

describe('standing orders: files, ids and the 8 KB budget (story 14 AC 1)', () => {
  it('adds a workspace order SO-<n> after every id on the host, with text, source, scope, check and state', async () => {
    const { addOrder, readOrderFile, orderFilePath, parseOrderFile } = await lib();
    const change = await addOrder('ws-a', { text: 'Land WIP before new work.', source: 'owner message ws-a/abc, 2026-11-02T01:00Z' }, [], T0);
    expect(change.order).toEqual({
      id: 'SO-8', text: 'Land WIP before new work.', source: 'owner message ws-a/abc, 2026-11-02T01:00Z',
      scope: 'ws-a', check: 'prose', state: 'active', added: '2026-11-03T10:00:00Z',
    });
    const next = await addOrder('ws-b', { text: 'Use ai-server for gates.', source: 'owner message ws-b/def, 2026-11-02T02:00Z', scope: 'workers', check: 'tests/unit/x.test.ts' }, [], T0);
    expect(next.order).toMatchObject({ id: 'SO-9', scope: 'workers', check: 'tests/unit/x.test.ts' });
    const raw = await fs.readFile(orderFilePath('ws-a'), 'utf-8');
    expect(orderFilePath('ws-a')).toBe(path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'standing-orders.md'));
    expect(parseOrderFile(raw, 'ws-a', 'x').orders).toEqual((await readOrderFile('ws-a')).orders);
  });

  it('refuses an order that would put a workspace over 8 KB, with the measured size', async () => {
    const { addOrder, readOrderFile, STANDING_ORDERS_MAX_BYTES } = await lib();
    expect(STANDING_ORDERS_MAX_BYTES).toBe(8192);
    const long = (i: number) => `${i} ${'x'.repeat(560)}`;
    let refusal: { code?: string; message?: string } | null = null;
    for (let i = 0; i < 20 && !refusal; i++) {
      await addOrder('ws-a', { text: long(i), source: `owner message ws-a/m${i}, 2026-11-03T00:00Z` }, [], T0)
        .catch((err: { code?: string; message?: string }) => { refusal = err; });
    }
    expect(refusal).toMatchObject({ code: 'so-too-large' });
    expect(refusal!.message).toMatch(/^standing orders for ws-a would be (\d{4}) bytes, at most 8192/);
    expect(Number(/would be (\d+) bytes/.exec(refusal!.message!)![1])).toBeGreaterThan(8192);
    const kept = (await readOrderFile('ws-a')).orders;
    const { sectionBytes } = await lib();
    expect(sectionBytes((await readOrderFile('fleet')).orders, kept)).toBeLessThanOrEqual(8192);
  });

  it('a fleet order is measured against every workspace it reaches', async () => {
    const { addOrder } = await lib();
    // Fill ws-b until it is refused: less room is left than one more 560-character order takes.
    for (let i = 0; i < 20; i++) await addOrder('ws-b', { text: `${i} ${'y'.repeat(560)}`, source: 's' }, [], T0).catch(() => {});
    const err = await addOrder('fleet', { text: 'z'.repeat(600), source: 's' }, ['ws-a'], T0).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'so-too-large' });
    expect((err as Error).message).toMatch(/^standing orders for ws-b would be \d+ bytes/);
  });

  it('refuses a field it cannot keep on one line, and names the field', async () => {
    const { addOrder } = await lib();
    expect(await errorCode(addOrder('ws-a', { text: 'two\nlines', source: 's' }, [], T0))).toBe('so-invalid');
    await expect(addOrder('ws-a', { text: 't', source: '' }, [], T0)).rejects.toThrow(/^source: required/);
    await expect(addOrder('ws-a', { text: 'x'.repeat(601), source: 's' }, [], T0)).rejects.toThrow('text: 601 characters, at most 600');
    await expect(addOrder('ws-a', { text: 't', source: 's', scope: 'a;b' }, [], T0)).rejects.toThrow(/^scope:/);
    await expect(addOrder('nope', { text: 't', source: 's' }, [], T0)).rejects.toThrow(/fleet or a workspace id/);
  });

  it('strikes an order in place, once; an unknown id is not found', async () => {
    const { addOrder, strikeOrder, readOrderFile } = await lib();
    await addOrder('ws-a', { text: 'Rule.', source: 's' }, [], T0);
    const struck = await strikeOrder('SO-8', 'owner withdrew it', () => {}, T0 + 60_000);
    expect(struck.order).toMatchObject({ id: 'SO-8', state: 'struck', struck: '2026-11-03T10:01:00Z — owner withdrew it' });
    expect((await readOrderFile('ws-a')).orders).toHaveLength(1);
    expect(await errorCode(strikeOrder('SO-8', 'again', () => {}, T0))).toBe('so-struck');
    expect(await errorCode(strikeOrder('SO-99', 'x', () => {}, T0))).toBe('so-not-found');
    expect(await errorCode(strikeOrder('SO-1', '', () => {}, T0))).toBe('so-invalid');
    // A new order never reuses a struck id.
    expect((await addOrder('ws-a', { text: 'Next.', source: 's' }, [], T0)).order.id).toBe('SO-9');
  });

  it('15 concurrent first reads on a fresh home: every section carries the seed, and the fleet file is written once (R3)', async () => {
    const { promptSectionFor, orderFilePath } = await lib();
    const fsp = (await import('fs/promises')).default;
    const renames = vi.spyOn(fsp, 'rename');
    const sections = await Promise.all(Array.from({ length: 15 }, (_, i) => promptSectionFor(`ws-p${i}`)));
    expect(sections.filter((s) => s.includes('- **SO-1** (fleet; check: prose)'))).toHaveLength(15);
    expect(sections.filter((s) => s.includes('could not be read'))).toEqual([]);
    expect(renames.mock.calls.filter(([, to]) => to === orderFilePath('fleet'))).toHaveLength(1);
    renames.mockRestore();
  });

  it('an empty or header-less file is unreadable, never zero orders (R3)', async () => {
    const { readOrderFile, orderFilePath } = await lib();
    await fs.mkdir(path.dirname(orderFilePath('fleet')), { recursive: true });
    await fs.writeFile(orderFilePath('fleet'), '');
    await expect(readOrderFile('fleet')).rejects.toThrow('does not start with "# Standing orders:"');
    await fs.writeFile(orderFilePath('fleet'), '## SO-1\n- text: t\n- source: s\n- scope: fleet\n- check: prose\n- state: active\n- added: x\n');
    expect(await errorCode(readOrderFile('fleet'))).toBe('so-unreadable');
  });

  it('never reuses an id, even when the file that held the highest is gone with its workspace directory (R5)', async () => {
    const { addOrder, orderFilePath, orderSeqPath } = await lib();
    expect((await addOrder('ws-p9', { text: 'top', source: 's' }, [], T0)).order.id).toBe('SO-8');
    await fs.rm(path.dirname(orderFilePath('ws-p9')), { recursive: true, force: true });
    expect((await addOrder('ws-p4', { text: 'later', source: 's' }, [], T0)).order.id).toBe('SO-9');
    expect(JSON.parse(await fs.readFile(orderSeqPath(), 'utf-8'))).toEqual({ high: 9 });
  });

  it('a corrupt seq file refuses the add as so-unreadable, naming the path, and changes no file (confirm NIT 3)', async () => {
    const { addOrder, orderFilePath, orderSeqPath, readOrderFile } = await lib();
    await readOrderFile('fleet');
    await addOrder('ws-a', { text: 'first', source: 's' }, [], T0);
    await fs.writeFile(orderSeqPath(), '{');
    const before = await Promise.all([orderFilePath('fleet'), orderFilePath('ws-a'), orderSeqPath()].map((f) => fs.readFile(f)));
    const err = await addOrder('ws-a', { text: 'second', source: 's' }, [], T0).catch((e: { code?: string; message?: string }) => e);
    expect(err).toMatchObject({ code: 'so-unreadable' });
    expect((err as Error).message).toContain(orderSeqPath());
    const after = await Promise.all([orderFilePath('fleet'), orderFilePath('ws-a'), orderSeqPath()].map((f) => fs.readFile(f)));
    after.forEach((buf, i) => expect(buf.equals(before[i])).toBe(true));
  });

  it('12 parallel adds get 12 unique ids (R7)', async () => {
    const { addOrder, readAllOrderFiles } = await lib();
    const adds = await Promise.all(Array.from({ length: 12 }, (_, i) => addOrder(i % 2 ? 'ws-p1' : 'ws-p2', { text: `rule ${i}`, source: 's' }, [], T0)));
    const ids = adds.map((a) => a.order.id);
    expect(new Set(ids).size).toBe(12);
    expect(ids.map((id) => Number(id.slice(3))).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 8));
    expect((await readAllOrderFiles()).flatMap((f) => f.orders).filter((o) => o.text.startsWith('rule '))).toHaveLength(12);
  });

  it('measures bytes, not characters: 600 x "€" is 1,800 bytes of text against the 8 KB cap (R7)', async () => {
    const { addOrder, sectionBytes, readOrderFile } = await lib();
    const fleet = (await readOrderFile('fleet')).orders;
    const before = sectionBytes(fleet, []);
    const change = await addOrder('ws-p3', { text: '€'.repeat(600), source: 's' }, [], T0);
    expect(Buffer.byteLength('€'.repeat(600))).toBe(1800);
    expect(change.bytes - before).toBe(Buffer.byteLength(`- **SO-8** (ws-p3; check: prose) ${'€'.repeat(600)}\n`));
    // Three fit; a fourth passes 8,192 bytes, where a character count (about 3,800) would let it in.
    for (let i = 0; i < 2; i++) await addOrder('ws-p3', { text: '€'.repeat(600), source: 's' }, [], T0);
    const refused = await addOrder('ws-p3', { text: '€'.repeat(600), source: 's' }, [], T0).catch((err: Error) => err);
    expect(refused).toMatchObject({ code: 'so-too-large' });
    const measured = Number(/would be (\d+) bytes/.exec((refused as Error).message)![1]);
    expect(measured).toBeGreaterThan(8192);
    expect(measured - 4 * 1800).toBeLessThan(8192 - 4 * 600);
  });

  it('refuses a hand-broken file, never reading it as empty', async () => {
    const { readOrderFile, orderFilePath, addOrder } = await lib();
    await fs.mkdir(path.dirname(orderFilePath('ws-a')), { recursive: true });
    await fs.writeFile(orderFilePath('ws-a'), '# Standing orders: ws-a\n\n## SO-3\n- text: t\n- colour: red\n');
    expect(await errorCode(readOrderFile('ws-a'))).toBe('so-unreadable');
    expect(await errorCode(addOrder('ws-a', { text: 't', source: 's' }, [], T0))).toBe('so-unreadable');
    expect(await fs.readFile(orderFilePath('ws-a'), 'utf-8')).toContain('colour: red');
  });
});

describe('who changes which orders, and what a change reaches (story 14 AC 1, AC 2)', () => {
  it('a tab adds orders for its own workspace; the fleet file is the admin token\'s', async () => {
    const { addStandingOrder, strikeStandingOrder } = await lib();
    const f = new Fanout();
    expect(await errorCode(addStandingOrder(f.deps(), caller('ws-a'), 'fleet', { text: 't', source: 's' }))).toBe('forbidden');
    expect(await errorCode(addStandingOrder(f.deps(), caller('ws-a'), 'ws-b', { text: 't', source: 's' }))).toBe('forbidden');
    expect(await errorCode(strikeStandingOrder(f.deps(), caller('ws-a'), 'SO-1', 'no'))).toBe('forbidden');
    expect((await addStandingOrder(f.deps(), caller('ws-a'), 'ws-a', { text: 't', source: 's' })).order.id).toBe('SO-8');
    expect((await addStandingOrder(f.deps(), ADMIN, 'fleet', { text: 'f', source: 's' })).order.id).toBe('SO-9');
  });

  it('a workspace order rewrites that workspace\'s prompt and sends its live tabs one urgent line naming the order', async () => {
    const { addStandingOrder } = await lib();
    const f = new Fanout();
    const result = await addStandingOrder(f.deps(), caller('ws-a'), 'ws-a', { text: 'Land WIP first.', source: 's' });
    expect(f.prompts).toEqual(['ws-a']);
    expect(f.routed).toEqual([
      { workspaceId: 'ws-a', tabId: 'tab-a1', kind: 'standing-order', class: 'urgent', text: '[purplemux standing order] SO-8 added (ws-a): Land WIP first. — it holds until struck; purplemux so list shows every order' },
      { workspaceId: 'ws-a', tabId: 'tab-a2', kind: 'standing-order', class: 'urgent', text: '[purplemux standing order] SO-8 added (ws-a): Land WIP first. — it holds until struck; purplemux so list shows every order' },
    ]);
    expect(result).toMatchObject({ promptsWritten: 1, tabsNotified: 2 });
  });

  it('a fleet strike reaches every workspace and every live tab', async () => {
    const { strikeStandingOrder } = await lib();
    const f = new Fanout();
    const result = await strikeStandingOrder(f.deps(), ADMIN, 'SO-7', 'replaced by the board push');
    expect(f.prompts).toEqual(['ws-a', 'ws-b']);
    expect(f.routed.map((r) => [r.tabId, r.class, r.text])).toEqual(f.tabs.map((t) => [t.tabId, 'urgent',
      '[purplemux standing order] SO-7 struck (fleet): Answer a bare status ask with `purplemux board show --line` and the board URL. — it no longer holds']));
    expect(result).toMatchObject({ promptsWritten: 2, tabsNotified: 3 });
  });

  it('a tab lists the fleet\'s orders and its own workspace\'s, active unless --all', async () => {
    const { addStandingOrder, strikeStandingOrder, listStandingOrders } = await lib();
    const f = new Fanout();
    await addStandingOrder(f.deps(), ADMIN, 'ws-b', { text: 'b only', source: 's' });
    await addStandingOrder(f.deps(), caller('ws-a'), 'ws-a', { text: 'a only', source: 's' });
    await strikeStandingOrder(f.deps(), ADMIN, 'SO-2', 'test');
    const mine = await listStandingOrders(caller('ws-a'), null, false);
    expect(mine.orders.map((o) => `${o.owner}:${o.id}`)).toEqual(['fleet:SO-1', 'fleet:SO-3', 'fleet:SO-4', 'fleet:SO-5', 'fleet:SO-6', 'fleet:SO-7', 'ws-a:SO-9']);
    expect((await listStandingOrders(caller('ws-a'), null, true)).orders).toHaveLength(8);
    expect(await errorCode(listStandingOrders(caller('ws-a'), 'ws-b', false))).toBe('forbidden');
    expect((await listStandingOrders(ADMIN, null, true)).orders.map((o) => o.id)).toContain('SO-8');
  });
});

describe('the workspace prompt file carries the active orders at every launch (story 14 AC 2)', () => {
  it('is rewritten by the Claude launch flags, so tab create and restart load the orders active now', async () => {
    const { addOrder, strikeOrder } = await lib();
    const { buildClaudeFlags } = await import('@/lib/claude-command');
    const { getClaudePromptPath } = await import('@/lib/claude-prompt');
    const flags = await buildClaudeFlags('ws-a');
    expect(flags).toContain(`--append-system-prompt-file ${getClaudePromptPath('ws-a')}`);
    let prompt = await fs.readFile(getClaudePromptPath('ws-a'), 'utf-8');
    expect(prompt).toContain('## Standing orders');
    expect(prompt).toContain('- **SO-4** (fleet; check: prose) Reversible work needs no approval. Dev and QA are not production.');
    await addOrder('ws-a', { text: 'Use ai-server for every gate.', source: 's' }, [], T0);
    await strikeOrder('SO-4', 'test', () => {}, T0);
    await buildClaudeFlags('ws-a');
    prompt = await fs.readFile(getClaudePromptPath('ws-a'), 'utf-8');
    expect(prompt).toContain('- **SO-8** (ws-a; check: prose) Use ai-server for every gate.');
    expect(prompt).not.toContain('SO-4');
    expect(prompt.indexOf('## Standing orders')).toBeGreaterThan(prompt.indexOf('### Tab type notes'));
  });

  it('a prompt file that cannot be written never blocks a launch: it loads the last file written (R6)', async () => {
    const { buildClaudeFlags } = await import('@/lib/claude-command');
    const { getClaudePromptPath } = await import('@/lib/claude-prompt');
    // A directory where the file goes: the rename fails.
    await fs.mkdir(getClaudePromptPath('ws-a'), { recursive: true });
    await expect(buildClaudeFlags('ws-a')).resolves.toContain(`--append-system-prompt-file ${getClaudePromptPath('ws-a')}`);
    const left = (await fs.readdir(path.dirname(getClaudePromptPath('ws-a')))).filter((name) => name.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('says so when the orders cannot be read, rather than dropping them', async () => {
    const { orderFilePath } = await lib();
    const { writeClaudePromptFile, getClaudePromptPath } = await import('@/lib/claude-prompt');
    await fs.mkdir(path.dirname(orderFilePath('fleet')), { recursive: true });
    await fs.writeFile(orderFilePath('fleet'), '# Standing orders: fleet\n\n## SO-x\n');
    await writeClaudePromptFile({ id: 'ws-a' });
    expect(await fs.readFile(getClaudePromptPath('ws-a'), 'utf-8')).toMatch(/The standing orders could not be read \(.*"## SO-x" is not an order id/);
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteError } from '@/lib/notes-store';

// G7 step 0: `POST /api/cli/notes/:id/point` takes no text (AC1) and answers every refusal with a CLI code (AC6).

const state = vi.hoisted(() => ({
  point: vi.fn(),
  caller: { workspaceId: 'ws-2', tabId: 'tab-b', verified: true, admin: false } as unknown,
}));

vi.mock('@/lib/lease-http', async (original) => ({
  ...await original<typeof import('@/lib/lease-http')>(),
  requireCaller: vi.fn(async () => state.caller),
}));
vi.mock('@/lib/notes-service', () => ({ getNotesService: async () => ({ point: state.point }) }));
vi.mock('@/lib/note-pointer', () => ({ defaultNotePointPort: async () => ({ withTarget: vi.fn() }) }));

const call = async (body: unknown, method = 'POST') => {
  const out = { code: 0, body: undefined as unknown };
  const res = {
    status(code: number) { out.code = code; return this; },
    json(value: unknown) { out.body = value; return this; },
    setHeader() {},
  } as unknown as NextApiResponse;
  const { default: handler } = await import('@/pages/api/cli/notes/[id]/point');
  await handler({ method, query: { id: 'n-abcd1' }, body, headers: {} } as unknown as NextApiRequest, res);
  return out;
};

describe('POST /api/cli/notes/:id/point', () => {
  beforeEach(() => {
    state.point.mockReset();
    state.point.mockResolvedValue({ status: 'sent', submitted: true, noteId: 'n-abcd1' });
  });

  it.each([
    ['free text', { content: 'deploy now' }],
    ['a target', { tabId: 'tab-x' }],
    ['a string body', 'deploy now'],
    ['an array body', ['x']],
  ])('refuses %s before any note is read (AC1)', async (_name, body) => {
    expect(await call(body)).toEqual({ code: 400, body: { error: 'a pointer carries no text: send no body', code: 'note-invalid' } });
    expect(state.point).not.toHaveBeenCalled();
  });

  it.each([[undefined], [null], [''], [{}]])('accepts an empty body (%j)', async (body) => {
    expect(await call(body)).toMatchObject({ code: 200, body: { status: 'sent', submitted: true } });
    expect(state.point).toHaveBeenCalledWith(state.caller, 'n-abcd1', expect.anything());
  });

  it.each([
    ['forbidden', 403], ['note-not-found', 404], ['tab-not-found', 404], ['session-not-running', 409],
    ['note-point-not-ready', 409], ['note-point-too-soon', 409],
  ] as const)('answers %s with %i and the code', async (code, status) => {
    state.point.mockRejectedValue(new NoteError(code, `refused: ${code}`));
    expect(await call(undefined)).toEqual({ code: status, body: { error: `refused: ${code}`, code } });
  });

  it('allows POST only', async () => {
    expect((await call(undefined, 'GET')).code).toBe(405);
  });
});

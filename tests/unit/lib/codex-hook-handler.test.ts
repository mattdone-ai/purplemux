import { describe, expect, it } from 'vitest';
import {
  processCodexHookPayload,
  shouldEmitCodexHookEvent,
} from '@/lib/providers/codex/hook-handler';

describe('processCodexHookPayload', () => {
  it.each(['PreToolUse', 'PostToolUse'])('reads %s as a prompt-submit from a tool, which starts no turn (story 15, review R5)', (name) => {
    expect(processCodexHookPayload({ hook_event_name: name, session_id: 's', tool_name: 'exec_command' }).translation.event)
      .toEqual({ kind: 'prompt-submit', fromTool: true });
  });

  it('translates Codex prompt hooks into provider-neutral meta and events', () => {
    const { result, translation } = processCodexHookPayload({
      hook_event_name: 'UserPromptSubmit',
      session_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      transcript_path: '/tmp/codex.jsonl',
      prompt: 'Implement the provider boundary',
    });

    expect(result).toEqual({ ok: true });
    expect(translation.event).toEqual({ kind: 'prompt-submit' });
    expect(translation.meta).toMatchObject({
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      jsonlPath: '/tmp/codex.jsonl',
      lastUserMessage: 'Implement the provider boundary',
      agentSummary: 'Implement the provider boundary',
    });
  });

  it('returns session side effects as data for SessionStart hooks', () => {
    const { translation } = processCodexHookPayload({
      hook_event_name: 'SessionStart',
      session_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      transcript_path: '/tmp/codex.jsonl',
      cwd: '/workspace/app',
      source: 'clear',
    });

    expect(translation.event).toEqual({ kind: 'session-start' });
    expect(translation.clearSession).toBe(true);
    expect(translation.meta).toMatchObject({
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      jsonlPath: '/tmp/codex.jsonl',
      clearMessages: true,
    });
    expect(translation.sessionInfo).toMatchObject({
      status: 'running',
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      jsonlPath: '/tmp/codex.jsonl',
      cwd: '/workspace/app',
    });
  });

  it('gates non-clear SessionStart events to inactive or unknown tabs', () => {
    const payload = { hook_event_name: 'SessionStart', source: 'startup' };

    expect(shouldEmitCodexHookEvent(payload, 'inactive')).toBe(true);
    expect(shouldEmitCodexHookEvent(payload, 'unknown')).toBe(true);
    expect(shouldEmitCodexHookEvent(payload, 'idle')).toBe(false);
    expect(shouldEmitCodexHookEvent({ ...payload, source: 'clear' }, 'idle')).toBe(true);
  });

  it('translates permission requests into meta patches and notification events', () => {
    const { translation } = processCodexHookPayload({
      hook_event_name: 'PermissionRequest',
      session_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      request_type: 'ExecApprovalRequest',
      exec_command: { command: 'pnpm test', cwd: '/workspace/app' },
    });

    expect(translation.event).toEqual({ kind: 'notification', notificationType: 'permission_prompt' });
    expect(translation.meta?.permissionRequest).toMatchObject({
      type: 'ExecApprovalRequest',
      command: 'pnpm test',
      cwd: '/workspace/app',
    });
  });
});

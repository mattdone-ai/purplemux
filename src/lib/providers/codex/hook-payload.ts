import type { TAgentWorkStateEvent } from '@/lib/providers/types';
import type {
  IApplyPatchApprovalRequest,
  IExecApprovalRequest,
  IPatchEntry,
  IPermissionRequest,
  IRequestPermissions,
  TPatchOperation,
} from '@/types/codex-permission';

export type TCodexHookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'PermissionRequest';

export type TCodexSessionSource = 'startup' | 'resume' | 'clear';

export interface ICodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string | null;
  source?: string;
  prompt?: string | null;
  call_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  request_type?: string;
  exec_command?: unknown;
  apply_patch?: unknown;
  requested_permissions?: unknown;
}

export const isCodexSessionSource = (value: unknown): value is TCodexSessionSource =>
  value === 'startup' || value === 'resume' || value === 'clear';

export const translateCodexHookEvent = (
  payload: ICodexHookPayload,
): TAgentWorkStateEvent | null => {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { kind: 'session-start' };
    case 'UserPromptSubmit':
      return { kind: 'prompt-submit' };
    case 'PreToolUse':
    case 'PostToolUse':
      return { kind: 'prompt-submit', fromTool: true };
    case 'Stop':
      return { kind: 'stop' };
    case 'PermissionRequest':
      return { kind: 'notification', notificationType: 'permission_prompt' };
    default:
      return null;
  }
};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const asStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const PATCH_OPERATIONS: ReadonlySet<TPatchOperation> = new Set(['modify', 'create', 'delete']);
const FILE_HEADER_RE = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s+(.+?)\s*$/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const normalizeToolName = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;

const patchOperationFromHeader = (op: string): TPatchOperation => {
  if (op.toLowerCase() === 'add') return 'create';
  if (op.toLowerCase() === 'delete') return 'delete';
  return 'modify';
};

const parseApplyPatchCommand = (command: string): IPatchEntry[] => {
  const patches: IPatchEntry[] = [];
  for (const line of command.split('\n')) {
    const match = line.match(FILE_HEADER_RE);
    if (!match) continue;
    patches.push({
      operation: patchOperationFromHeader(match[1]),
      path: match[2],
      diff: command,
    });
  }
  return patches.length > 0
    ? patches
    : [{ operation: 'modify', path: 'apply_patch', diff: command }];
};

const parseExecApproval = (
  payload: ICodexHookPayload,
): IExecApprovalRequest | null => {
  const ec = payload.exec_command;
  if (!ec || typeof ec !== 'object') return null;
  const command = asString((ec as Record<string, unknown>).command);
  if (!command) return null;
  const result: IExecApprovalRequest = { type: 'ExecApprovalRequest', command };
  const callId = asString(payload.call_id) ?? asString((ec as Record<string, unknown>).call_id);
  if (callId) result.callId = callId;
  const cwd = asString((ec as Record<string, unknown>).cwd) ?? asString(payload.cwd);
  if (cwd) result.cwd = cwd;
  const env = asStringRecord((ec as Record<string, unknown>).env);
  if (env) result.env = env;
  return result;
};

const parseToolInputExecApproval = (
  payload: ICodexHookPayload,
): IExecApprovalRequest | null => {
  const toolName = normalizeToolName(payload.tool_name);
  const toolInput = asRecord(payload.tool_input);
  if (!toolName || !toolInput) return null;
  if (toolName !== 'bash' && toolName !== 'exec_command') return null;

  const command = asString(toolInput.command);
  if (!command) return null;
  const result: IExecApprovalRequest = { type: 'ExecApprovalRequest', command };
  const cwd = asString(payload.cwd);
  if (cwd) result.cwd = cwd;
  return result;
};

const parsePatchEntry = (raw: unknown): IPatchEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const path = asString(obj.path);
  const opRaw = asString(obj.operation);
  if (!path || !opRaw || !PATCH_OPERATIONS.has(opRaw as TPatchOperation)) return null;
  const entry: IPatchEntry = { path, operation: opRaw as TPatchOperation };
  const diff = asString(obj.diff);
  if (diff) entry.diff = diff;
  const content = asString(obj.content);
  if (content) entry.content = content;
  return entry;
};

const parseApplyPatchApproval = (
  payload: ICodexHookPayload,
): IApplyPatchApprovalRequest | null => {
  const ap = payload.apply_patch;
  if (!ap || typeof ap !== 'object') return null;
  const rawPatches = (ap as Record<string, unknown>).patches;
  if (!Array.isArray(rawPatches)) return null;
  const patches = rawPatches.map(parsePatchEntry).filter((p): p is IPatchEntry => p !== null);
  if (patches.length === 0) return null;
  const result: IApplyPatchApprovalRequest = { type: 'ApplyPatchApprovalRequest', patches };
  const callId = asString(payload.call_id) ?? asString((ap as Record<string, unknown>).call_id);
  if (callId) result.callId = callId;
  return result;
};

const parseToolInputApplyPatchApproval = (
  payload: ICodexHookPayload,
): IApplyPatchApprovalRequest | null => {
  const toolName = normalizeToolName(payload.tool_name);
  const toolInput = asRecord(payload.tool_input);
  if (toolName !== 'apply_patch' || !toolInput) return null;

  const command = asString(toolInput.command);
  if (!command) return null;
  return {
    type: 'ApplyPatchApprovalRequest',
    patches: parseApplyPatchCommand(command),
  };
};

const parseRequestPermissions = (
  payload: ICodexHookPayload,
): IRequestPermissions | null => {
  const rp = payload.requested_permissions;
  if (!Array.isArray(rp)) return null;
  const permissions = rp.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (permissions.length === 0) return null;
  const result: IRequestPermissions = { type: 'RequestPermissions', permissions };
  const callId = asString(payload.call_id);
  if (callId) result.callId = callId;
  return result;
};

export const parseCodexPermissionRequest = (
  payload: ICodexHookPayload,
): IPermissionRequest | null => {
  if (payload.hook_event_name !== 'PermissionRequest') return null;
  const explicit = asString(payload.request_type);
  if (explicit === 'RequestPermissions' || (!explicit && !payload.exec_command && !payload.apply_patch)) {
    const parsed = parseRequestPermissions(payload);
    if (parsed) return parsed;
  }
  if (explicit === 'ApplyPatchApprovalRequest' || payload.apply_patch) {
    const parsed = parseApplyPatchApproval(payload);
    if (parsed) return parsed;
  }
  if (explicit === 'ExecApprovalRequest' || payload.exec_command) {
    const parsed = parseExecApproval(payload);
    if (parsed) return parsed;
  }
  const parsedToolApplyPatch = parseToolInputApplyPatchApproval(payload);
  if (parsedToolApplyPatch) return parsedToolApplyPatch;
  const parsedToolExec = parseToolInputExecApproval(payload);
  if (parsedToolExec) return parsedToolExec;
  return null;
};

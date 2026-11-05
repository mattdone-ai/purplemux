import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ILedgerTokenIssued } from '@/types/ledger';

/**
 * Producer tokens (ADR-0033 §Transport): the single scope `ledger:emit` on one workspace. They live
 * apart from the CLI, workspace and tab tokens, so `resolveCliScope` never matches one and every
 * other route refuses it. The file keeps only a SHA-256 of each token.
 */
export const LEDGER_SCOPE = 'ledger:emit';

interface ILedgerTokenRecord {
  hash: string;
  workspaceId: string;
  producer: string;
  issuedAt: number;
}

interface ILedgerTokenFile {
  version: 1;
  tokens: ILedgerTokenRecord[];
}

const tokensFile = (): string => path.join(os.homedir(), '.purplemux', 'ledger-tokens.json');

const g = globalThis as unknown as { __ptLedgerTokens?: ILedgerTokenFile };

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

const load = (): ILedgerTokenFile => {
  if (g.__ptLedgerTokens) return g.__ptLedgerTokens;
  let parsed: ILedgerTokenFile = { version: 1, tokens: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(tokensFile(), 'utf-8')) as Partial<ILedgerTokenFile>;
    if (Array.isArray(raw.tokens)) parsed = { version: 1, tokens: raw.tokens };
  } catch {
    parsed = { version: 1, tokens: [] };
  }
  g.__ptLedgerTokens = parsed;
  return parsed;
};

const persist = (file: ILedgerTokenFile): void => {
  const target = tokensFile();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
};

/** Issue a token for `producer` on `workspaceId`; an earlier token of the same pair stops working. */
export const issueLedgerToken = (workspaceId: string, producer: string, now: number): ILedgerTokenIssued => {
  const token = `pmlg_${randomBytes(32).toString('hex')}`;
  const current = load();
  const next: ILedgerTokenFile = {
    version: 1,
    tokens: [
      ...current.tokens.filter((record) => !(record.workspaceId === workspaceId && record.producer === producer)),
      { hash: hashOf(token), workspaceId, producer, issuedAt: now },
    ],
  };
  persist(next);
  g.__ptLedgerTokens = next;
  return { scope: LEDGER_SCOPE, workspaceId, producer, token, issuedAt: now };
};

/** The workspace and producer a presented token emits for, or null for any other value. */
export const resolveLedgerToken = (value: string | null | undefined): { workspaceId: string; producer: string } | null => {
  if (!value) return null;
  const hash = Buffer.from(hashOf(value), 'hex');
  const record = load().tokens.find((entry) => {
    const stored = Buffer.from(entry.hash, 'hex');
    return stored.length === hash.length && timingSafeEqual(stored, hash);
  });
  return record ? { workspaceId: record.workspaceId, producer: record.producer } : null;
};

import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// The proof of an owner's AWS sign-in (ADR-0041): the AWS CLI's own SSO token cache, read as files.
// No `aws` process is ever started and no AWS endpoint is called: DEC-261 forbids an agent run
// through the owner's SSO unless the owner asks.

export const AWS_PROFILE = /^[A-Za-z0-9._-]{1,64}$/;
/** A token that expires sooner than this is no sign-in to wake a tab for: its step could not finish (review r1, R8). */
export const SSO_MIN_VALIDITY_MS = 5 * 60_000;

export interface ISsoProfile {
  profile: string;
  /** The cache file name without `.json`: sha1 of the sso-session name, or of a legacy profile's start URL. */
  cacheKey: string;
  via: 'sso-session' | 'sso_start_url';
}

/** `expired` includes a token with less than SSO_MIN_VALIDITY_MS left. */
export type TSsoTokenState =
  | { state: 'valid'; expiresAt: number }
  | { state: 'expired'; expiresAt: number }
  | { state: 'absent' };

export class SsoConfigError extends Error {}

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

/** `~/.aws/config` as sections of key/value pairs; comments and blank lines are skipped. */
export const parseAwsConfig = (text: string): Map<string, Record<string, string>> => {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1].replace(/\s+/g, ' '), current);
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2].trim();
  }
  return sections;
};

/** The cache entry a profile signs in to, or null when the profile is not an SSO profile. */
export const resolveSsoProfile = (configText: string, profile: string): ISsoProfile | null => {
  const sections = parseAwsConfig(configText);
  const section = sections.get(profile === 'default' ? 'default' : `profile ${profile}`);
  if (!section) return null;
  if (section.sso_session) {
    return sections.has(`sso-session ${section.sso_session}`)
      ? { profile, cacheKey: sha1(section.sso_session), via: 'sso-session' }
      : null;
  }
  return section.sso_start_url ? { profile, cacheKey: sha1(section.sso_start_url), via: 'sso_start_url' } : null;
};

/** The AWS CLI writes `2026-11-03T09:41:23Z`; older versions wrote `...UTC`. */
export const parseSsoExpiry = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.trim().replace(/UTC$/, 'Z'));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The token state of one cache file's JSON. A client registration (`botocore-client-*`) carries
 * `expiresAt` too but no `accessToken`: it proves nothing about a sign-in.
 */
export const tokenState = (json: unknown, now: number): TSsoTokenState => {
  if (!json || typeof json !== 'object') return { state: 'absent' };
  const record = json as Record<string, unknown>;
  const expiresAt = parseSsoExpiry(record.expiresAt);
  if (typeof record.accessToken !== 'string' || !record.accessToken || expiresAt === null) return { state: 'absent' };
  return expiresAt - now >= SSO_MIN_VALIDITY_MS ? { state: 'valid', expiresAt } : { state: 'expired', expiresAt };
};

// Both paths stay literal under the home directory: a computed root makes the Next build trace the whole project.
export const awsConfigFile = (): string => path.join(os.homedir(), '.aws', 'config');
const ssoCacheFile = (cacheKey: string): string => path.join(os.homedir(), '.aws', 'sso', 'cache', `${cacheKey}.json`);

const readConfig = async (): Promise<string> => {
  try {
    return await fs.readFile(awsConfigFile(), 'utf-8');
  } catch (err) {
    throw new SsoConfigError(`the AWS config is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
};

/** The profile's cache entry; refuses a profile the AWS config does not define as SSO. */
export const findSsoProfile = async (profile: string): Promise<ISsoProfile> => {
  if (!AWS_PROFILE.test(profile)) throw new SsoConfigError(`a profile name is 1-64 of A-Z a-z 0-9 . _ -, got ${JSON.stringify(profile)}`);
  const resolved = resolveSsoProfile(await readConfig(), profile);
  if (!resolved) throw new SsoConfigError(`profile ${profile} has no sso_session or sso_start_url in ${awsConfigFile()}`);
  return resolved;
};

/** The profile's token state now, from its one cache file; no file is `absent`. */
export const readSsoToken = async (profile: string, now: number): Promise<TSsoTokenState> => {
  const resolved = await findSsoProfile(profile);
  let raw: string;
  try {
    raw = await fs.readFile(ssoCacheFile(resolved.cacheKey), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    throw new SsoConfigError(`the SSO cache file is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  try {
    return tokenState(JSON.parse(raw), now);
  } catch {
    // The CLI rewrites the file in place; a half-written file is read again on the next pass.
    return { state: 'absent' };
  }
};

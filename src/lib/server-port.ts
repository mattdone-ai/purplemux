import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_SERVER_PORT = 8022;

/** This server's listening port: `PORT` (set by server.ts once it listens), else `~/.purplemux/port`, else 8022. */
export const readServerPort = (): number => {
  if (process.env.PORT && /^\d{1,5}$/.test(process.env.PORT)) return Number(process.env.PORT);
  try {
    const port = readFileSync(path.join(os.homedir(), '.purplemux', 'port'), 'utf-8').trim();
    if (/^\d{1,5}$/.test(port)) return Number(port);
  } catch {
    // no port file: the default below
  }
  return DEFAULT_SERVER_PORT;
};

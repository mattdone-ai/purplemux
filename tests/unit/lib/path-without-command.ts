import fs from 'fs';
import path from 'path';

/**
 * A PATH directory that holds every command of `/usr/bin` and `/bin` except `omit`, as symlinks (PMUX-REMOTE-URL r4):
 * a hook script then runs as it does on a host where that command is not installed. The caller's own fakes go in
 * front of it on PATH.
 */
export const pathWithoutCommand = (dir: string, omit: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  for (const source of ['/usr/bin', '/bin']) {
    if (!fs.existsSync(source)) continue;
    for (const name of fs.readdirSync(source)) {
      if (name === omit) continue;
      const link = path.join(dir, name);
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(source, name), link);
    }
  }
  return dir;
};

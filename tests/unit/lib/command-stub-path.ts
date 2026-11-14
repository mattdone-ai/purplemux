import fs from 'fs';
import path from 'path';

/**
 * The commands a hook script runs, besides curl and tmux (PMUX-REMOTE-URL r4). `tmux` is each test's own fake.
 */
export const HOOK_SCRIPT_COMMANDS = ['sh', 'cat', 'cut', 'date', 'dirname', 'grep', 'head', 'mkdir', 'mv', 'od', 'rm', 'sed', 'sleep', 'timeout', 'tr'];

/** The real file a command names on `searchPath`, or null: links are followed, so a dangling one is no command. */
const resolveCommand = (name: string, searchPath: string): string | null => {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // not here
    }
  }
  return null;
};

/**
 * A directory to be the ONLY PATH entry of a hook run that must find no curl (PMUX-REMOTE-URL r4, CI run
 * 43560733268): it holds a link to each named command, resolved from this process's PATH, and nothing else. It
 * never depends on what the host has installed: curl cannot be named, and a command the host lacks fails loudly.
 */
export const commandStubPath = (dir: string, commands: readonly string[] = HOOK_SCRIPT_COMMANDS): string => {
  if (commands.includes('curl')) throw new Error('a stub PATH without curl cannot name curl');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of commands) {
    const target = resolveCommand(name, process.env.PATH ?? '');
    if (!target) throw new Error(`the stub PATH needs ${name}, which is not on this host's PATH`);
    fs.symlinkSync(target, path.join(dir, name));
  }
  return dir;
};

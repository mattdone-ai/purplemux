import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The worker-events routes import these modules, so Turbopack traces their file operations. A
// `path.join` or `path.resolve` built from an argument cannot be scoped to a folder: the build then
// traces the whole project into .next/standalone and scripts/post-build.js refuses it (46101d53).
// The first build of ADR-0043 hit exactly this through the review-folder validator.

const ROOT = path.resolve(__dirname, '../../..');
const TRACED = [
  'src/lib/worker-event-validators.ts',
  'src/lib/worker-event-schema.ts',
  'src/lib/worker-events-service.ts',
  'src/lib/worker-events-http.ts',
];

const code = (file: string): string => fs
  .readFileSync(path.join(ROOT, file), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('typed worker events stay scoped in the Next trace', () => {
  it.each(TRACED)('%s builds no path with path.join or path.resolve', (file) => {
    expect(code(file)).not.toMatch(/\bpath\.(join|resolve)\(/);
  });
});

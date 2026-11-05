// Text that looks like a credential. One owner for the patterns (story 16 consult, ruling 7): a match means the
// text is never shown, and a partial redaction is never attempted, since part of a secret still leaks it.

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S{4,}/i,
  /\b[A-Fa-f0-9]{40,}\b/,
  // A long base64 run with a digit and both cases: a key, not a path or a word.
  /(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/,
];

export const looksLikeSecret = (text: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(text));

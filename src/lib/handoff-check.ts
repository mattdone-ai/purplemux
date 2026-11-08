// Browser-safe: the seat handoff checker (ADR-0036 §4; ADR-HFL-04 decision 4 as amended by HFL-consult-06).
// One pure function, `checkHandoff(text, now, rotateRequestedAt)`, used by the rotation and by
// `purplemux handoff check`. Its rules and its refusal wording are v2's `tools/lib/handoffcheck.py`, so both
// checkers give one verdict per file; character classes copy Python's (`str.isspace`, `str.splitlines`,
// Unicode `\d`) for the same reason.

export const HANDOFF_MAX_BYTES = 12288;
const FUTURE_SLACK_US = 5 * 60 * 1_000_000;

export const HANDOFF_SECTIONS = [
  'Role', 'In flight', 'Open questions', 'Standing rules', 'Decisions in the last 24 h', 'Do not', 'Resume command',
] as const;

const TITLE = '# Handoff: <seat> · updated <UTC ISO>';
const UTC_FORMS = 'YYYY-MM-DDTHH:MM[:SS[.ffffff]] ending in Z or +00:00';
const TABLE_HEADER = ['item key', 'state', 'next action', 'waiting on'];
const SEPARATOR = '| --- | --- | --- | --- |';
export const SOURCE_FORMS = '(source: DEC-<n> | ARC-<n> | SO-<n> | owner message <UTC date> | lane ledger <name> '
  + '<YYYY-MM-DDTHH:MM:SSZ>), one source, by id; an item number such as (3) goes in the rule text';

/** Python's `str.isspace()` set: what `strip()` and `\s` read as whitespace. */
const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const re = (source: string): RegExp => new RegExp(`^(?:${source})$`, 'u');
const S = `[${WS}]`;
const NS = `[^${WS}]`;

const UTC_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:Z|\+00:00)$/;
const TITLE_RE = re('# Handoff: ([A-Za-z0-9._-]+) · updated (' + NS + '+)');
const HEADING_RE = re(`(#{1,6})${S}+(.*?)${S}*`);
const GROUP_LABEL_RE = re(`#{3,6}${S}.*`);
const FENCE_OPEN_RE = new RegExp(`^${S}*(\`{3,}|~{3,})(.*)$`, 'u');
const ITEM_ID = '[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+';
const ITEM_ID_RE = re(`(?:- )?(?:${ITEM_ID}|\`${ITEM_ID}\`)(?:${S}*:${S}+${NS}.*|${S}+[—-]${S}+${NS}.*|${S}+\\(.*\\)|${S}+\\[.*\\])?`);
const SOURCE_RE = re(`(?:DEC|ARC|SO)-\\p{Nd}+|owner message (?<date>${NS}+)|lane ledger [A-Za-z0-9][A-Za-z0-9_-]{0,31} (?<stamp>${NS}+)`);
const LEDGER_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UTC_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RULE_RE = re(`- (?<text>${NS}.*?)${S}\\(source: (?<sources>.+)\\)\\.?`);
const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const IS_SPACE = new RegExp(`^${S}$`, 'u');
const STRIP = new RegExp(`^${S}+|${S}+$`, 'gu');
const RSTRIP = new RegExp(`${S}+$`, 'u');

const strip = (text: string): string => text.replace(STRIP, '');

/** Python's `str.splitlines()`: no trailing empty line for a final break. */
const splitLines = (text: string): string[] => {
  const lines = text.split(LINE_BREAK);
  if (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
};

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const validDate = (year: number, month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) && year >= 1;

/**
 * The UTC time a stamp names, in microseconds since the epoch, or null when it is not one of UTC_FORMS. `24:00`
 * (with no minute, second or fraction past it) is the next midnight, as v2's Python 3.14 `fromisoformat` reads it.
 */
export const parseUtcStamp = (text: string): number | null => {
  const match = UTC_ISO.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const micros = match[7] === undefined ? 0 : Number(match[7].padEnd(6, '0'));
  if (!validDate(year, month, day) || minute > 59 || second > 59) return null;
  if (hour > 24 || (hour === 24 && (minute > 0 || second > 0 || micros > 0))) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second) * 1000 + micros;
};

const isUtcDate = (text: string): boolean => {
  const match = UTC_DATE_RE.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return parseUtcStamp(text) !== null;
};

const fmt = (micros: number): string => `${new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19)}Z`;

/** One line quoted for a reason, cut at `width` characters. */
export const showLine = (line: string, width = 60): string => {
  const chars = Array.from(line);
  return `"${chars.length <= width ? line : `${chars.slice(0, width).join('')}...`}"`;
};

/** Python's `str.isprintable()` is false for every \p{C} and \p{Z} character but the space: `repr` escapes those. */
const NOT_PRINTABLE = /(?! )[\p{C}\p{Z}]/gu;

const PY_NAMED_ESCAPES = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']]);

const pyEscape = (char: string): string => {
  const code = char.codePointAt(0)!;
  const named = PY_NAMED_ESCAPES.get(char);
  if (named) return named;
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
  return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`;
};

/** A Python list of strings as `repr` prints it, so the header refusal reads the same in both checkers. */
const pyList = (items: readonly string[]): string => `[${items.map((item) => {
  const quote = item.includes("'") && !item.includes('"') ? '"' : "'";
  const body = item.replace(/\\/g, '\\\\').replace(NOT_PRINTABLE, pyEscape);
  return `${quote}${quote === "'" ? body.replace(/'/g, "\\'") : body}${quote}`;
}).join(', ')}]`;

class Fence {
  private char = '';
  private length = 0;

  /** Feeds one line; true when the line is inside a fence or is a fence line itself. */
  step(line: string): boolean {
    if (this.char) {
      const close = new RegExp(`^${S}*${this.char === '`' ? '`' : '~'}{${this.length},}${S}*$`, 'u');
      if (close.test(line)) this.char = '';
      return true;
    }
    const match = FENCE_OPEN_RE.exec(line);
    if (!match || (match[1][0] === '`' && match[2].includes('`'))) return false;
    this.char = match[1][0];
    this.length = match[1].length;
    return true;
  }
}

interface ISections {
  title: number | null;
  headings: Array<[string, number]>;
  bodies: Map<string, string[]>;
  reasons: string[];
}

const splitSections = (lines: readonly string[]): ISections => {
  let title: number | null = null;
  const headings: Array<[string, number]> = [];
  const bodies = new Map<string, string[]>();
  const reasons: string[] = [];
  let current: string[] | null = null;
  const fence = new Fence();
  lines.forEach((line, index) => {
    const match = fence.step(line) ? null : HEADING_RE.exec(line);
    if (match && match[1].length === 1) {
      if (title === null) title = index;
      else reasons.push(`a second level-1 heading at line ${index + 1}: ${showLine(line)} (expected one, the title line ${TITLE})`);
      current = null;
    } else if (match && match[1].length === 2) {
      const name = match[2];
      headings.push([name, index + 1]);
      if (bodies.has(name)) {
        current = null;
      } else {
        current = [];
        bodies.set(name, current);
      }
    } else if (current) {
      current.push(line);
    }
  });
  return { title, headings, bodies, reasons };
};

interface ITitle {
  reasons: string[];
  seat: string | null;
  updatedAt: number | null;
}

const checkTitle = (lines: readonly string[], title: number | null, now: number, requestedAt: number | null): ITitle => {
  const first = lines.findIndex((line) => strip(line) !== '');
  if (title === null) {
    const measured = first >= 0 ? showLine(lines[first]) : 'an empty file';
    return { reasons: [`no title line: the first non-empty line is ${measured} (expected ${TITLE})`], seat: null, updatedAt: null };
  }
  const reasons: string[] = [];
  if (first !== title) {
    reasons.push(`title not on the first non-empty line: line ${first + 1} ${showLine(lines[first])} comes before it at line ${title + 1} (expected the title first)`);
  }
  const match = TITLE_RE.exec(lines[title].replace(RSTRIP, ''));
  if (!match) return { reasons: [...reasons, `title line ${showLine(lines[title])} does not match ${TITLE}`], seat: null, updatedAt: null };
  const stamp = parseUtcStamp(match[2]);
  if (stamp === null) {
    return { reasons: [...reasons, `updated stamp ${showLine(match[2])} is not a UTC time (expected ${UTC_FORMS})`], seat: match[1], updatedAt: null };
  }
  if (requestedAt !== null && stamp < requestedAt) {
    reasons.push(`updated stamp ${match[2]} is older than the rotate request ${fmt(requestedAt)} (expected at or after it)`);
  }
  if (stamp > now + FUTURE_SLACK_US) {
    reasons.push(`updated stamp ${match[2]} is in the future: now is ${fmt(now)} (expected at most ${fmt(now + FUTURE_SLACK_US)}, now + 5 min)`);
  }
  return { reasons, seat: match[1], updatedAt: Math.floor(stamp / 1000) };
};

const checkHeadings = (headings: ReadonlyArray<[string, number]>): string[] => {
  const reasons: string[] = [];
  const known: readonly string[] = HANDOFF_SECTIONS;
  const names = headings.map(([name]) => name);
  for (const [name, line] of headings) {
    if (!known.includes(name)) {
      reasons.push(`unknown heading "## ${name}" at line ${line} (expected only the ${known.length} schema headings: ${known.join(', ')})`);
    }
  }
  for (const name of known) {
    const count = names.filter((n) => n === name).length;
    if (count === 0) reasons.push(`missing heading "## ${name}" (expected once)`);
    else if (count > 1) reasons.push(`heading "## ${name}" appears ${count} times (expected once)`);
  }
  const seen = [...new Set(names)].filter((name) => known.includes(name));
  const expected = known.filter((name) => seen.includes(name));
  if (seen.join('\0') !== expected.join('\0')) {
    reasons.push(`headings out of order: measured ${seen.join(' > ')} (expected ${expected.join(' > ')})`);
  }
  return reasons;
};

const filled = (body: readonly string[]): string[] => body.map(strip).filter(Boolean);

/** The items of an itemised section: `###` group labels dropped, an indented line joined to the item before it. */
export const handoffItems = (body: readonly string[]): string[] => {
  const out: string[] = [];
  for (const line of body) {
    const bare = strip(line);
    if (!bare || GROUP_LABEL_RE.test(bare)) continue;
    if (IS_SPACE.test(Array.from(line)[0]) && out.length) out[out.length - 1] += ` ${bare}`;
    else out.push(bare);
  }
  return out;
};

const checkRole = (body: readonly string[]): string[] => {
  const count = filled(body).length;
  return count >= 1 && count <= 3 ? [] : [`## Role has ${count} non-empty lines (expected 1 to 3)`];
};

const checkResume = (body: readonly string[]): string[] => {
  const count = filled(body).length;
  return count === 1 ? [] : [`## Resume command has ${count} non-empty lines (expected exactly 1)`];
};

const isNone = (lines: readonly string[]): boolean => lines.length === 1 && lines[0] === 'none';

const checkOpenQuestions = (body: readonly string[]): string[] => {
  const lines = handoffItems(body);
  if (!lines.length) return ['## Open questions is empty (expected Mission Control item ids, or none)'];
  if (isNone(lines)) return [];
  return lines.filter((line) => !ITEM_ID_RE.test(line)).map((line) => `## Open questions item ${showLine(line)} is not a Mission Control item id `
    + '(expected "- <item-id>", optionally in backticks and with a note after —, -, : or in brackets; or none alone)');
};

/** One source of the five admitted forms; its owner-message date a UTC date, its ledger stamp a UTC time to the second. */
const validSource = (source: string): boolean => {
  const match = SOURCE_RE.exec(source);
  if (!match) return false;
  const { date, stamp } = match.groups ?? {};
  if (date !== undefined) return isUtcDate(date);
  if (stamp !== undefined) return LEDGER_STAMP_RE.test(stamp) && parseUtcStamp(stamp) !== null;
  return true;
};

const checkStandingRules = (body: readonly string[]): string[] => {
  const lines = handoffItems(body);
  if (!lines.length) return ['## Standing rules is empty (expected one "- <rule> (source: ...)" item each, or none)'];
  if (isNone(lines)) return [];
  return lines
    .filter((line) => {
      const match = RULE_RE.exec(line);
      return !match || !validSource(match.groups!.sources);
    })
    .map((line) => `standing rule ${showLine(line)} has no valid source (expected "- <rule> ${SOURCE_FORMS}")`);
};

const tableCells = (line: string): string[] | null =>
  (line.startsWith('|') && line.endsWith('|') ? line.slice(1, -1).split('|').map(strip) : null);

const checkInFlight = (body: readonly string[]): string[] => {
  const lines = filled(body);
  if (!lines.length) return [`## In flight is empty (expected the table | ${TABLE_HEADER.join(' | ')} |, or none)`];
  if (isNone(lines)) return [];
  const rows = lines.map(tableCells);
  const bad = rows.findIndex((row) => row === null);
  if (bad >= 0) return [`## In flight line ${showLine(lines[bad])} is not a table row (expected only the table, or none alone)`];
  const cells = rows as string[][];
  if (cells[0].map((cell) => cell.toLowerCase()).join('\0') !== TABLE_HEADER.join('\0')) {
    return [`## In flight header ${pyList(cells[0])} (expected ${pyList(TABLE_HEADER)})`];
  }
  if (cells.length < 2) return [`## In flight has no separator row under the header (expected ${SEPARATOR})`];
  if (cells[1].length !== 4 || !cells[1].every((cell) => SEPARATOR_CELL_RE.test(cell))) {
    return [`## In flight separator row ${showLine(lines[1])} is not 4 cells of --- (expected ${SEPARATOR})`];
  }
  return cells.slice(2).flatMap((row, i) => (row.length !== 4 || !row[0]
    ? [`## In flight row ${showLine(lines[i + 2])} has ${row.length} cells, item key ${showLine(row[0])} (expected 4 cells and a non-empty item key)`]
    : []));
};

const CHECKS: ReadonlyArray<[string, (body: readonly string[]) => string[]]> = [
  ['Role', checkRole], ['In flight', checkInFlight], ['Open questions', checkOpenQuestions],
  ['Standing rules', checkStandingRules], ['Resume command', checkResume],
];

export interface IHandoffCheck {
  ok: boolean;
  /** One line per refusal, each with what it measured beside what it expected. */
  reasons: string[];
  seat: string | null;
  /** The title's `updated` stamp in ms, or null when it does not parse. */
  updatedAt: number | null;
  /** The one line of `## Resume command`, or null when the section does not hold exactly one. */
  resumeCommand: string | null;
}

/**
 * The verdict on one handoff text. `now` and `rotateRequestedAt` are ms since the epoch; a null request skips the
 * "older than the request" check (`purplemux handoff check` with no `--rotate-requested-at`).
 */
export const checkHandoff = (text: string, now: number, rotateRequestedAt: number | null): IHandoffCheck => {
  const reasons: string[] = [];
  const size = new TextEncoder().encode(text).length;
  if (size > HANDOFF_MAX_BYTES) reasons.push(`size ${size} bytes (expected at most ${HANDOFF_MAX_BYTES}, 12 KB)`);
  const lines = splitLines(text);
  const sections = splitSections(lines);
  const title = checkTitle(lines, sections.title, now * 1000, rotateRequestedAt === null ? null : rotateRequestedAt * 1000);
  reasons.push(...title.reasons, ...sections.reasons, ...checkHeadings(sections.headings));
  for (const [name, check] of CHECKS) {
    const body = sections.bodies.get(name);
    if (body) reasons.push(...check(body));
  }
  const resume = sections.bodies.get('Resume command');
  const resumeLines = resume ? filled(resume) : [];
  return {
    ok: reasons.length === 0,
    reasons,
    seat: title.seat,
    updatedAt: title.updatedAt,
    resumeCommand: resumeLines.length === 1 ? resumeLines[0] : null,
  };
};

/** The structured fields of a handoff, read with the checker's own splitter; meaningful only after a pass. */
export interface IHandoffFields {
  role: string[];
  inFlight: Array<{ itemKey: string; state: string; nextAction: string; waitingOn: string }>;
  /** `## Open questions`: Mission Control item ids, the note after each dropped. */
  openQuestions: string[];
  /** The one source of each standing rule, as written. */
  standingRuleSources: string[];
  decisions: string[];
  doNot: string[];
  resumeCommand: string | null;
}

const LEADING_ITEM_ID_RE = new RegExp(`^(?:- )?\`?(${ITEM_ID})\`?`, 'u');

export const handoffFields = (text: string): IHandoffFields => {
  const { bodies } = splitSections(splitLines(text));
  const items = (name: string): string[] => {
    const lines = handoffItems(bodies.get(name) ?? []);
    return isNone(lines) ? [] : lines.map((line) => line.replace(/^- /, ''));
  };
  const rows = filled(bodies.get('In flight') ?? []).map(tableCells).filter((row): row is string[] => row !== null && row.length === 4);
  const resume = filled(bodies.get('Resume command') ?? []);
  const sources = handoffItems(bodies.get('Standing rules') ?? []);
  return {
    role: filled(bodies.get('Role') ?? []),
    inFlight: rows.slice(2).map(([itemKey, state, nextAction, waitingOn]) => ({ itemKey, state, nextAction, waitingOn })),
    openQuestions: items('Open questions').map((line) => LEADING_ITEM_ID_RE.exec(line)?.[1] ?? line),
    standingRuleSources: isNone(sources) ? [] : sources.map((line) => RULE_RE.exec(line)?.groups?.sources ?? '').filter(Boolean),
    decisions: items('Decisions in the last 24 h'),
    doNot: items('Do not'),
    resumeCommand: resume.length === 1 ? resume[0] : null,
  };
};

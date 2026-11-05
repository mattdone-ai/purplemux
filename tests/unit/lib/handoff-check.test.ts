import { describe, expect, it } from 'vitest';
import { HANDOFF_MAX_BYTES, HANDOFF_SECTIONS, SOURCE_FORMS, checkHandoff, handoffItems, parseUtcStamp, showLine } from '@/lib/handoff-check';

// ADR-0036 §4 (ADR-HFL-04 decision 4 as amended by HFL-consult-06). The fixtures and every refusal string are
// v2's `tools/lib/handoffcheck.py` tests, so both checkers give one verdict, and one wording, per file.

const NOW = Date.UTC(2026, 10, 3, 12, 0);
const STAMP = '2026-11-03T11:50:00Z';

const SECTIONS: Record<string, string> = {
  Role: '/v2-orchestrate: dispatch lanes from docs/lanes.yaml and own the landing queue.',
  'In flight': '| item key | state | next action | waiting on |\n| --- | --- | --- | --- |\n'
    + '| fold47 | gated | arm | none |\n| kit-hfl06 | review | land | the reviewer |',
  'Open questions': '- approvers-1102\n- an1-pr288: the merge waits for Greg',
  'Standing rules': '- Pin the identity on every gh write. (source: lane ledger ORCH-1027 2026-11-03T02:58:09Z)\n'
    + '- Land with V2_GATE_REMOTE=0 after a local pre-flight. (source: DEC-58)\n'
    + '- Arm remote only when the load is 32 or more. (source: ARC-183)\n'
    + '- Never print env output. (source: owner message 2026-11-02)\n'
    + '- Mask every IBAN. (source: owner message 2026-11-02T04:55Z)',
  'Decisions in the last 24 h': '- fold47 rides alone (ledger 2026-11-03T08:00Z).',
  'Do not': '- Do not rotate a seat mid-landing.',
  'Resume command': '/v2-orchestrate',
};

const handoff = (
  sections: Record<string, string | null> = {},
  title = `# Handoff: orchestrator · updated ${STAMP}`,
  order: string[] = Object.keys(SECTIONS),
): string => {
  const body = { ...SECTIONS, ...sections };
  const parts = [title, ''];
  for (const name of order) {
    const value = body[name];
    if (value !== null && value !== undefined) parts.push(`## ${name}`, value, '');
  }
  return parts.join('\n');
};

const reasons = (text: string, rotateRequestedAt: number | null = null) => checkHandoff(text, NOW, rotateRequestedAt).reasons;

describe('a passing handoff', () => {
  it('passes the fixture, also with a stamp equal to the rotate request', () => {
    const result = checkHandoff(handoff(), NOW, null);
    expect(result).toMatchObject({ ok: true, reasons: [], seat: 'orchestrator', resumeCommand: '/v2-orchestrate' });
    expect(result.updatedAt).toBe(Date.UTC(2026, 10, 3, 11, 50));
    expect(reasons(handoff(), Date.UTC(2026, 10, 3, 11, 50))).toEqual([]);
  });

  it('takes none in each section that takes it', () => {
    expect(reasons(handoff({ 'In flight': 'none', 'Open questions': 'none', 'Standing rules': 'none' }))).toEqual([]);
  });

  it.each([
    'SO-12', 'SO-1', 'DEC-301', 'ARC-1065', 'owner message 2026-10-31', 'owner message 2026-10-31T04:55:00Z',
    'owner message 2026-10-31T04:55+00:00', 'lane ledger ORCH-1027 2026-11-03T02:58:09Z',
    'lane ledger kit 2026-11-03T01:44:47Z', 'lane ledger SM 2026-11-03T00:00:00Z', 'lane ledger a_b-9 2026-11-03T00:00:00Z',
    `lane ledger ${'L'.repeat(32)} 2026-11-03T00:00:00Z`,
  ])('passes the source form %s alone (AC 3)', (source) => {
    expect(reasons(handoff({ 'Standing rules': `- a rule (source: ${source})` }))).toEqual([]);
  });

  it.each([
    '- DEC-213 (3): a rule (source: DEC-213).',
    '- a rule, ARC-1064 (5), (6) (source: ARC-1064)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T02:58:09Z).',
    '- a rule (source: SO-12).',
  ])('takes a full stop after the source and an item number in the rule text: %s', (line) => {
    expect(reasons(handoff({ 'Standing rules': line }))).toEqual([]);
  });

  it('skips group labels and joins a wrapped line to its item', () => {
    const rules = '### Landing\n- Land with V2_GATE_REMOTE=0 after a local\n  pre-flight PASS. (source: DEC-58)\n\n'
      + '#### Secrets\n- Never print env output; test keys with jq has(),\n'
      + '\tnames only (source: owner message\n  2026-11-02)';
    const questions = '### Owner\n- approvers-1102\n### SM\n- an1-pr288';
    const text = handoff({
      'Standing rules': rules, 'Open questions': questions, 'Decisions in the last 24 h': '### Kit\n- one', 'Do not': '### Never\n- two',
    });
    expect(reasons(text)).toEqual([]);
    expect(handoffItems(rules.split('\n'))).toEqual([
      '- Land with V2_GATE_REMOTE=0 after a local pre-flight PASS. (source: DEC-58)',
      '- Never print env output; test keys with jq has(), names only (source: owner message 2026-11-02)',
    ]);
    expect(handoffItems(['  an indented first line'])).toEqual(['an indented first line']);
  });

  it('reads free sections, deeper headings and fenced hashes as text', () => {
    expect(reasons(handoff({ 'Do not': '### Never\n```bash\n# a comment, not a heading\n## nor this\n```', 'Decisions in the last 24 h': '' }))).toEqual([]);
  });

  it('closes a fence only on its own string', () => {
    expect(reasons(handoff({ 'Do not': '~~~\n```\n## not a heading\n~~~\n````\n## nor this\n```\n## still not\n````' }))).toEqual([]);
  });

  it('opens no fence on a one-line code span; an unclosed fence hides the headings after it', () => {
    expect(reasons(handoff({ 'Do not': '```make land```' }))).toEqual([]);
    expect(reasons(handoff({ 'Do not': '```bash' }))).toEqual(['missing heading "## Resume command" (expected once)']);
  });

  it('passes a size of exactly 12 KB', () => {
    const base = handoff();
    const text = base.replace('## Do not\n', `## Do not\n${'x'.repeat(HANDOFF_MAX_BYTES - Buffer.byteLength(base) - 1)}\n`);
    expect(Buffer.byteLength(text)).toBe(12288);
    expect(reasons(text)).toEqual([]);
  });
});

describe('headings', () => {
  it.each(HANDOFF_SECTIONS.map((name) => [name]))('names the missing heading %s', (name) => {
    expect(reasons(handoff({ [name]: null }))).toContain(`missing heading "## ${name}" (expected once)`);
  });

  it('refuses an out-of-order heading with both orders', () => {
    const order = [...HANDOFF_SECTIONS];
    [order[0], order[1]] = [order[1], order[0]];
    const found = reasons(handoff({}, undefined, order));
    expect(found).toHaveLength(1);
    expect(found[0].startsWith('headings out of order: measured In flight > Role > Open questions')).toBe(true);
    expect(found[0]).toContain('(expected Role > In flight > Open questions');
  });

  it('refuses an unknown heading', () => {
    const found = reasons(handoff().replace('## Do not', '## Notes\nsomething\n\n## Do not'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^unknown heading "## Notes" at line \d+ \(expected only the 7 schema headings: /);
  });

  it('refuses a duplicate heading', () => {
    expect(reasons(`${handoff()}## Role\nagain\n`)).toContain('heading "## Role" appears 2 times (expected once)');
  });

  it('refuses a second level-1 heading', () => {
    const found = reasons(handoff().replace('## Do not', '# Extra\n\n## Do not'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^a second level-1 heading at line \d+: "# Extra"/);
  });
});

describe('the title and its stamp', () => {
  it('refuses a missing title and an empty file', () => {
    expect(reasons(handoff().split('\n').slice(1).join('\n')))
      .toEqual(['no title line: the first non-empty line is "## Role" (expected # Handoff: <seat> · updated <UTC ISO>)']);
    expect(reasons('')).toContain('no title line: the first non-empty line is an empty file (expected # Handoff: <seat> · updated <UTC ISO>)');
  });

  it('refuses text before the title, as one reason', () => {
    expect(reasons(`\npreamble\n${handoff()}`))
      .toEqual(['title not on the first non-empty line: line 2 "preamble" comes before it at line 3 (expected the title first)']);
    const found = reasons(`preamble\n${handoff({}, '# Handoff: kit - updated x')}`);
    expect(found).toHaveLength(2);
    expect(found[1].startsWith('title line "# Handoff: kit - updated x" does not match')).toBe(true);
  });

  it('refuses a malformed title', () => {
    const found = reasons(handoff({}, `# Handoff: orchestrator - updated ${STAMP}`));
    expect(found).toHaveLength(1);
    expect(found[0].startsWith('title line "# Handoff: orchestrator - updated')).toBe(true);
  });

  it.each(['2026-11-03T11:50:00', '2026-11-03T11:50:00+01:00', '2026-11-03', '2026-13-03T11:50:00Z', 'yesterday', '2026-11-03T11:50:00z', '2026-02-30T00:00Z', '2026-11-03T24:01Z'])(
    'refuses the stamp %s',
    (stamp) => {
      expect(reasons(handoff({}, `# Handoff: kit · updated ${stamp}`)))
        .toEqual([`updated stamp "${stamp}" is not a UTC time (expected YYYY-MM-DDTHH:MM[:SS[.ffffff]] ending in Z or +00:00)`]);
    },
  );

  it.each(['2026-11-03T11:50Z', '2026-11-03T11:50:00Z', '2026-11-03T11:50:00.123456Z', '2026-11-03T11:50:00+00:00', '2026-11-03T11:50+00:00'])(
    'passes the UTC form %s',
    (stamp) => {
      expect(reasons(handoff({}, `# Handoff: kit · updated ${stamp}`))).toEqual([]);
    },
  );

  it('reads +00:00 as Z and keeps microseconds', () => {
    expect(parseUtcStamp('2026-11-03T11:50:00+00:00')).toEqual(parseUtcStamp('2026-11-03T11:50:00Z'));
    expect(parseUtcStamp('2024-02-29T00:00Z')).not.toBeNull();
    // v2's checker runs on Python 3.14, whose fromisoformat reads 24:00 as the next midnight: the same verdict here.
    expect(parseUtcStamp('2026-11-03T24:00Z')).toEqual(parseUtcStamp('2026-11-04T00:00Z'));
    expect(parseUtcStamp('2026-11-03T11:50:00.000001Z')! - parseUtcStamp('2026-11-03T11:50:00Z')!).toBe(1);
  });

  it('refuses a stamp older than the rotate request (AC 3)', () => {
    expect(reasons(handoff(), Date.UTC(2026, 10, 3, 11, 55)))
      .toEqual([`updated stamp ${STAMP} is older than the rotate request 2026-11-03T11:55:00Z (expected at or after it)`]);
  });

  it('refuses a stamp a microsecond older than the rotate request', () => {
    const title = '# Handoff: kit · updated 2026-11-03T11:54:59.999999Z';
    expect(reasons(handoff({}, title), Date.UTC(2026, 10, 3, 11, 55))).toHaveLength(1);
  });

  it('refuses a stamp more than 5 min ahead', () => {
    expect(reasons(handoff({}, '# Handoff: kit · updated 2026-11-03T12:05:00Z'))).toEqual([]);
    expect(reasons(handoff({}, '# Handoff: kit · updated 2026-11-03T12:05:01Z'))).toEqual([
      'updated stamp 2026-11-03T12:05:01Z is in the future: now is 2026-11-03T12:00:00Z (expected at most 2026-11-03T12:05:00Z, now + 5 min)',
    ]);
  });
});

describe('sections', () => {
  it('refuses a size over 12 KB', () => {
    const text = handoff({ 'Do not': 'x'.repeat(12288) });
    expect(reasons(text)).toEqual([`size ${Buffer.byteLength(text)} bytes (expected at most 12288, 12 KB)`]);
  });

  it('takes 1 to 3 role lines', () => {
    expect(reasons(handoff({ Role: 'a\nb\n\nc' }))).toEqual([]);
    expect(reasons(handoff({ Role: 'a\nb\nc\nd' }))).toEqual(['## Role has 4 non-empty lines (expected 1 to 3)']);
    expect(reasons(handoff({ Role: '' }))).toEqual(['## Role has 0 non-empty lines (expected 1 to 3)']);
  });

  it('takes exactly one resume command line', () => {
    expect(reasons(handoff({ 'Resume command': '/v2-orchestrate\n/v2-status' }))).toEqual(['## Resume command has 2 non-empty lines (expected exactly 1)']);
    expect(reasons(handoff({ 'Resume command': '' }))).toEqual(['## Resume command has 0 non-empty lines (expected exactly 1)']);
    expect(checkHandoff(handoff({ 'Resume command': '' }), NOW, null).resumeCommand).toBeNull();
  });

  it('refuses empty open questions', () => {
    expect(reasons(handoff({ 'Open questions': '' }))).toEqual(['## Open questions is empty (expected Mission Control item ids, or none)']);
  });

  it.each(['the owner has not answered', '- nohyphen', '- approvers-1102 and more', 'none\n- a-1', '- `approvers-1102', '- approvers-1102 —', '- approvers-1102 (waits'])(
    'refuses the open question %j',
    (line) => {
      const found = reasons(handoff({ 'Open questions': line }));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((r) => r.startsWith('## Open questions item ') && r.includes('is not a Mission Control item id'))).toBe(true);
    },
  );

  it.each(['- `approvers-1102`', 'approvers-1102', '- approvers-1102 — waits for the owner', '- approvers-1102 - waits', '- `approvers-1102`: waits', '- approvers-1102 (asked 11-02)', '- approvers-1102 [money]'])(
    'passes the open question %j',
    (line) => {
      expect(reasons(handoff({ 'Open questions': line }))).toEqual([]);
    },
  );

  it.each([
    '- a rule', '- a rule (source: SO-x)', '- a rule (source: owner)', '- a rule (DEC-1)',
    '- a rule (source: owner message 2026-02-30)', '- a rule (source: owner message 2026-11-02T04:55)',
    '- a rule (source: DEC-1) more', 'a rule (source: DEC-1)', '- (source: DEC-1)',
    '- a rule (source: KR-25)', '- a rule (source: DEC-1, KR-25)', '- a rule (source: DEC-1 3)',
    '- a rule (source: DEC-1,ARC-2)', '- a rule (source: DEC-1)..', '- a rule (source: )',
    '- a rule (source: DEC-1, owner message 2026-02-30)',
    '- a rule (source: DEC-233, ARC-1065)', '- a rule (source: DEC-233 (4), ARC-1065)',
    '- a rule (source: DEC-213 (3))', '- a rule (source: ARC-1064 (5), (6))',
    '- a rule (source: owner message 2026-11-02, DEC-1)',
    '- a rule (source: KR-19)', '- a rule (source: C-02)', '- a rule (source: C-KITOPT-PREFLIGHT)',
    '- a rule (source: ORCH-1027 2026-11-03T02:58:09Z)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T02:58Z)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T02:5xZ)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T02:58:09+00:00)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T02:58:09.5Z)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03T25:58:09Z)',
    '- a rule (source: lane ledger ORCH-1027 2026-11-03)',
    '- a rule (source: lane ledger ORCH-1027)', '- a rule (source: lane ledger 2026-11-03T02:58:09Z)',
    '- a rule (source: lane ledger -ORCH 2026-11-03T02:58:09Z)',
    '- a rule (source: lane ledger ORCH.1027 2026-11-03T02:58:09Z)',
    '- a rule (source: lane ledger ORCH 1027 2026-11-03T02:58:09Z)',
    `- a rule (source: lane ledger ${'L'.repeat(33)} 2026-11-03T02:58:09Z)`,
    '- a rule (source: SO-4 (2))',
  ])('refuses the standing rule %j (AC 3)', (line) => {
    expect(reasons(handoff({ 'Standing rules': line })))
      .toEqual([`standing rule ${showLine(line)} has no valid source (expected "- <rule> ${SOURCE_FORMS}")`]);
  });

  it('names the admitted kinds in the refusal', () => {
    for (const kind of ['DEC-<n>', 'ARC-<n>', 'SO-<n>', 'owner message <UTC date>', 'lane ledger <name> <YYYY-MM-DDTHH:MM:SSZ>', 'one source, by id']) {
      expect(SOURCE_FORMS).toContain(kind);
    }
  });

  it('refuses empty standing rules', () => {
    expect(reasons(handoff({ 'Standing rules': '' }))).toEqual(['## Standing rules is empty (expected one "- <rule> (source: ...)" item each, or none)']);
  });

  it('cuts a long rule in the reason', () => {
    const found = reasons(handoff({ 'Standing rules': `- ${'r'.repeat(80)}` }));
    expect(found[0].startsWith(`standing rule "- ${'r'.repeat(58)}..." has no valid source`)).toBe(true);
  });
});

describe('the in-flight table', () => {
  const HEAD = '| item key | state | next action | waiting on |\n| --- | :---: | ---: | :--- |\n';
  const check = (body: string) => reasons(handoff({ 'In flight': body }));

  it('takes any header case and separator alignment', () => {
    expect(check('| Item Key | State | Next action | Waiting on |\n|---|---|---|---|\n| a | b | c | |')).toEqual([]);
    expect(check(`${HEAD}| a | b | c | d |`)).toEqual([]);
  });

  it('refuses an empty section and passes an empty table', () => {
    expect(check('')).toEqual(['## In flight is empty (expected the table | item key | state | next action | waiting on |, or none)']);
    expect(check(HEAD)).toEqual([]);
  });

  it('refuses another header row', () => {
    expect(check('| key | state | next | waiting |\n| --- | --- | --- | --- |\n| a | b | c | d |'))
      .toEqual(["## In flight header ['key', 'state', 'next', 'waiting'] (expected ['item key', 'state', 'next action', 'waiting on'])"]);
    expect(check('|\n| --- |')).toEqual(["## In flight header [''] (expected ['item key', 'state', 'next action', 'waiting on'])"]);
  });

  it('escapes a non-printable header character as Python\'s repr does (v2 parity)', () => {
    expect(check('| it\ufeffem key | state | next\u00a0action | waiting on |\n| --- | --- | --- | --- |'))
      .toEqual(["## In flight header ['it\\ufeffem key', 'state', 'next\\xa0action', 'waiting on'] (expected ['item key', 'state', 'next action', 'waiting on'])"]);
    expect(check("| it's | state | next action | waiting on |\n| --- | --- | --- | --- |")[0]).toContain(`["it's", 'state'`);
  });

  it('refuses a missing or bad separator', () => {
    const header = '| item key | state | next action | waiting on |';
    expect(check(header)).toEqual(['## In flight has no separator row under the header (expected | --- | --- | --- | --- |)']);
    for (const line of ['| a | b | c | d |', '| --- | --- | --- |', '| -- | -- | -- | -- |']) {
      expect(check(`${header}\n${line}`)).toEqual([`## In flight separator row "${line}" is not 4 cells of --- (expected | --- | --- | --- | --- |)`]);
    }
  });

  it('refuses a bad row', () => {
    expect(check(`${HEAD}| a | b | c |`)).toEqual(['## In flight row "| a | b | c |" has 3 cells, item key "a" (expected 4 cells and a non-empty item key)']);
    expect(check(`${HEAD}|  | b | c | d |`)).toEqual(['## In flight row "|  | b | c | d |" has 4 cells, item key "" (expected 4 cells and a non-empty item key)']);
  });

  it('refuses text beside the table', () => {
    expect(check(`prose\n${HEAD}| a | b | c | d |`)).toEqual(['## In flight line "prose" is not a table row (expected only the table, or none alone)']);
  });
});

describe('line ends', () => {
  it('reads CRLF files as the same handoff', () => {
    expect(reasons(handoff().replace(/\n/g, '\r\n'))).toEqual([]);
  });
});

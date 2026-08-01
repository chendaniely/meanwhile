import { describe, expect, it } from 'vitest';
import {
  DATA_FILES,
  SETTINGS_HEADERS,
  SETTINGS_KEYS,
  fetchableCsvUrl,
  formatSettingsCsv,
  keyValueCsvKind,
  parseSettingsCsv,
  settingsKeyFor,
  type SettingsRow,
} from '../src/core/settings-csv.ts';
import { parseCsv } from '../src/core/csv.ts';

/** A Google Sheets page, the shape the Share dialog hands you. */
function sheet(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`;
}

/** The same document, as the address that answers with CSV. */
function exported(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

const IDS = {
  event: '1JZ5rQm7zK0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  placements: '1Yi7rQm7zK0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  markers: '18Y3rQm7zK0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  notes: '1IqsrQm7zK0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  people: '1tCErQm7zK0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
};

/**
 * The owner's real file, comments and section headings and all — including
 * `github_repo`, which nothing reads today and which must survive anyway.
 */
const OWNERS_FILE = [
  'key,value',
  '# --- the five data files ---',
  `event_url,${sheet(IDS.event)}`,
  `placements_url,${sheet(IDS.placements)}`,
  `markers_url,${sheet(IDS.markers)}`,
  `notes_url,${sheet(IDS.notes)}`,
  `people_url,${sheet(IDS.people)}`,
  '# --- where the written record is versioned ---',
  'github_repo,chendaniely/meanwhile-cm100-g',
  '',
].join('\n');

function file(lines: readonly string[]): string {
  return `key,value\n${lines.join('\n')}\n`;
}

/** The rows a written file reads back as, as `key,value` pairs in file order. */
function rowsOf(text: string): Array<[string, string]> {
  return parseSettingsCsv(text).rows.map((row) => [row.key, row.value]);
}

/** Just the keys, in file order, comments included. */
function keySequence(text: string): string[] {
  return parseSettingsCsv(text).rows.map((row) => row.key);
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

describe('settings.csv — reading', () => {
  it("reads the five data files' addresses from the owner's file", () => {
    const { urls, problems } = parseSettingsCsv(OWNERS_FILE);
    expect(problems).toEqual([]);
    expect(urls).toEqual({
      event: [exported(IDS.event)],
      people: [exported(IDS.people)],
      notes: [exported(IDS.notes)],
      markers: [exported(IDS.markers)],
      placements: [exported(IDS.placements)],
    });
  });

  it('keeps a "#" row in the file and never reads it as a setting', () => {
    const { urls, rows, problems } = parseSettingsCsv(
      file([
        `# event_url,${sheet('OLD')}`,
        `event_url,${sheet('NEW')}`,
        `#photos_url,${sheet('DISABLED')}`,
      ]),
    );
    expect(urls.event).toEqual([exported('NEW')]);
    // A commented-out address is not a file this build cannot read; it is not a
    // file at all, so nothing is reported about it.
    expect(problems).toEqual([]);
    // Skipped as DATA, not dropped from the file.
    expect(rows.map((r) => r.key)).toEqual(['# event_url', 'event_url', '#photos_url']);
  });

  it('does not let a "#" row decide what the file is', () => {
    const { problems } = parseSettingsCsv(
      file(['# title,Ridgeline 100', `event_url,${sheet('E')}`]),
    );
    expect(problems).toEqual([]);
  });

  it('keeps a key it has no meaning for, so it can be filled in before the build that reads it', () => {
    const { rows, problems } = parseSettingsCsv(OWNERS_FILE);
    expect(rows).toContainEqual({
      key: 'github_repo',
      value: 'chendaniely/meanwhile-cm100-g',
    });
    expect(problems).toEqual([]);
  });

  it('reads a ";"-separated value as several addresses, whatever spacing they were typed with', () => {
    const { urls, problems } = parseSettingsCsv(
      file([`notes_url, ${sheet('A')} ; https://example.test/priya-notes.csv ;${sheet('C')}`]),
    );
    expect(urls.notes).toEqual([
      exported('A'),
      'https://example.test/priya-notes.csv',
      exported('C'),
    ]);
    expect(problems).toEqual([]);
  });

  it('trims a key, so a cell a spreadsheet padded still names its file', () => {
    const { urls, rows } = parseSettingsCsv(file([` event_url ,${sheet('E')}`]));
    expect(urls.event).toEqual([exported('E')]);
    expect(rows).toEqual([{ key: 'event_url', value: sheet('E') }]);
  });

  it('drops the blanks a stray ";" leaves behind rather than inventing an address', () => {
    const { urls } = parseSettingsCsv(file([`notes_url,${sheet('A')};;`]));
    expect(urls.notes).toEqual([exported('A')]);
  });

  it('reads a key with a blank value as naming no file, and says nothing about it', () => {
    const { urls, rows, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'notes_url,']),
    );
    expect(urls.notes).toEqual([]);
    expect(rows).toContainEqual({ key: 'notes_url', value: '' });
    expect(problems).toEqual([]);
  });

  it('reports a missing header row and reads that line as a setting', () => {
    const { urls, problems } = parseSettingsCsv(
      [`event_url,${sheet('E')}`, `notes_url,${sheet('N')}`].join('\n'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('should begin with a header row reading "key,value"');
    // The point of reporting rather than refusing: the eaten line is still read.
    expect(urls.event).toEqual([exported('E')]);
    expect(urls.notes).toEqual([exported('N')]);
  });

  it('reports a header row whose second column name is the wrong one too', () => {
    // Checking only the first name would let "key,url" through, and the file
    // would then be read with its first setting eaten as column names.
    const { urls, problems } = parseSettingsCsv(['key,url', `event_url,${sheet('E')}`].join('\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('should begin with a header row reading "key,value"');
    expect(problems[0]).toContain('"key,url"');
    expect(urls.event).toEqual([exported('E')]);
  });

  it('reports the line standing in for a missing header when IT has no key, rather than keeping a row Save would delete', () => {
    // The bug this pins: the eaten header line skipped the blank-key check, so
    // parseSettingsCsv returned a row with a key of "" — the one shape
    // formatSettingsCsv drops — and the next Save deleted the address with
    // nothing said anywhere.
    const { rows, problems } = parseSettingsCsv(
      [',https://lost.test/x.csv', `event_url,${sheet('E')}`].join('\n'),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('should begin with a header row reading "key,value"');
    expect(problems[1]).toContain('nothing in the first column');
    expect(rows.map((r) => r.key)).toEqual(['event_url']);
    // Whatever parseSettingsCsv hands back, formatSettingsCsv writes back: no
    // row it returns may be one the writer silently drops.
    expect(rows.every((r) => r.key.trim() !== '')).toBe(true);
    expect(rowsOf(formatSettingsCsv(rows))).toEqual(rows.map((r) => [r.key, r.value]).concat([['schema', '1']]));
  });

  it('reports a row with nothing in the first column and ignores it', () => {
    const { rows, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, `,${sheet('ORPHAN')}`]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('nothing in the first column');
    expect(rows.map((r) => r.key)).toEqual(['event_url']);
  });

  it('reports a key named twice, and the last one wins', () => {
    const { urls, problems } = parseSettingsCsv(
      file([`event_url,${sheet('FIRST')}`, `event_url,${sheet('SECOND')}`]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('names "event_url" more than once');
    expect(urls.event).toEqual([exported('SECOND')]);
  });

  it('refuses a file written by a newer build, and keeps every row of it', () => {
    const text = file([`event_url,${sheet('E')}`, 'github_repo,a/b', 'schema,99']);
    const { urls, rows, problems } = parseSettingsCsv(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('settings.csv');
    expect(problems[0]).toContain('schema 99');
    expect(problems[0]).toContain('nothing in');
    // Nothing was read from it...
    expect(urls.event).toEqual([]);
    // ...and nothing was lost from it either.
    expect(rows.map((r) => r.key)).toEqual(['event_url', 'github_repo', 'schema']);
    expect(formatSettingsCsv(rows)).toContain('schema,99');
  });

  it('names the file first in the problem that refuses it, and names the file it was told about', () => {
    const { problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'schema,99']),
      'priya-settings.csv',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.startsWith('priya-settings.csv has schema 99')).toBe(true);
  });

  it('refuses a schema that is not a whole number', () => {
    const { urls, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'schema,one']),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not a whole number');
    expect(urls.event).toEqual([]);
  });

  it('reads a blank schema cell as the version this build knows', () => {
    const { urls, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'schema,']),
    );
    expect(problems).toEqual([]);
    expect(urls.event).toEqual([exported('E')]);
  });

  it('reports a *_url naming a file it does not know, without refusing the rest', () => {
    const { urls, rows, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, `photos_url,${sheet('P')}`]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"photos_url"');
    expect(problems[0]).toContain('event_url, people_url, notes_url, markers_url, placements_url');
    expect(urls.event).toEqual([exported('E')]);
    expect(rows).toContainEqual({ key: 'photos_url', value: sheet('P') });
  });

  it('says nothing about a key that is not a *_url at all', () => {
    const { problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'github_repo,a/b', 'author,Priya']),
    );
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

describe('settings.csv — Google Sheets addresses', () => {
  it('turns the address the Share dialog gives you into the CSV export', () => {
    expect(fetchableCsvUrl(sheet('ABC123'))).toBe(
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv',
    );
  });

  it('keeps the gid from the fragment, so a workbook does not export the wrong tab', () => {
    expect(
      fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=847362819'),
    ).toBe('https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=847362819');
  });

  it('keeps a gid given in the query, and names it once when both carry it', () => {
    expect(
      fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit?gid=55&usp=sharing'),
    ).toBe('https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=55');
    expect(
      fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit?gid=55#gid=55'),
    ).toBe('https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=55');
  });

  it('drops the /u/N/ that names whichever Google account was signed in', () => {
    expect(
      fetchableCsvUrl('https://docs.google.com/spreadsheets/u/2/d/ABC123/edit?usp=sharing'),
    ).toBe('https://docs.google.com/spreadsheets/d/ABC123/export?format=csv');
  });

  it('turns a bare document address into the CSV export', () => {
    expect(fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123')).toBe(
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv',
    );
    expect(fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/')).toBe(
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv',
    );
  });

  it('leaves an address that already asks for CSV exactly as it is', () => {
    for (const already of [
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv',
      'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=7',
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabc/pub?output=csv',
      'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv',
    ]) {
      expect(fetchableCsvUrl(already)).toBe(already);
    }
  });

  it('leaves an address that is not Google Sheets untouched', () => {
    for (const elsewhere of [
      'https://gist.githubusercontent.com/dan/abc/raw/notes.csv',
      'https://storage.googleapis.com/a-bucket/people.csv',
      'https://raw.githubusercontent.com/chendaniely/meanwhile-cm100-g/main/notes.csv',
      'https://docs.google.com/document/d/ABC123/edit',
      './notes.csv',
    ]) {
      expect(fetchableCsvUrl(elsewhere)).toBe(elsewhere);
    }
  });

  it('leaves a spreadsheet-shaped path on some other host alone, rather than sending it to Google', () => {
    // The dangerous failure is not "it was not rewritten": it is that rewriting
    // builds a fresh docs.google.com address out of the id, so a host check
    // that let these through would silently change WHERE the file is read from.
    for (const elsewhere of [
      'https://evil.test/spreadsheets/d/ABC123/edit',
      'https://docs.google.com.evil.test/spreadsheets/d/ABC123/edit?usp=sharing',
    ]) {
      expect(fetchableCsvUrl(elsewhere)).toBe(elsewhere);
    }
  });

  it('hands back a string that names no address at all exactly as it was given', () => {
    for (const raw of ['', '   ', 'TBD', 'notes.csv']) expect(fetchableCsvUrl(raw)).toBe(raw);
  });

  it('trims an address pasted with spaces around it, rather than failing to recognise it', () => {
    expect(fetchableCsvUrl(`  ${sheet('ABC123')}  `)).toBe(exported('ABC123'));
  });

  it('ignores a gid that is not a number, rather than asking for a tab that cannot exist', () => {
    expect(fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=all')).toBe(
      exported('ABC123'),
    );
  });

  it('reads gid as a parameter of its own, never as the tail of a longer name', () => {
    expect(fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit?tabgid=99')).toBe(
      exported('ABC123'),
    );
  });

  it('takes the query gid when the query and the fragment name different tabs', () => {
    expect(fetchableCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit?gid=7#gid=9')).toBe(
      `${exported('ABC123')}&gid=7`,
    );
  });

  it('does not upgrade a scheme somebody typed', () => {
    const insecure = 'http://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing';
    expect(fetchableCsvUrl(insecure)).toBe(insecure);
  });

  it('rewrites the address it hands out and never the one in the file', () => {
    const text = file([`event_url,${sheet('ABC123')}`]);
    const { urls, rows } = parseSettingsCsv(text);
    expect(urls.event).toEqual([exported('ABC123')]);
    // The file keeps the link a person can click.
    expect(rows).toContainEqual({ key: 'event_url', value: sheet('ABC123') });
    expect(formatSettingsCsv(rows)).toContain(sheet('ABC123'));
    expect(formatSettingsCsv(rows)).not.toContain('export?format=csv');
  });
});

// ---------------------------------------------------------------------------
// the round trip
// ---------------------------------------------------------------------------

describe('settings.csv — writing', () => {
  it('gives back a file that carries a schema exactly as it was organised', () => {
    const text = file([
      '# --- the five data files ---',
      `event_url,${sheet(IDS.event)}`,
      `notes_url,${sheet(IDS.notes)}`,
      '# --- where the written record is versioned ---',
      'github_repo,chendaniely/meanwhile-cm100-g',
      'schema,1',
    ]);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows);
    expect(rowsOf(written)).toEqual(rowsOf(text));
    // ...and again, so the second write is stable too.
    expect(rowsOf(formatSettingsCsv(parseSettingsCsv(written).rows))).toEqual(rowsOf(text));
  });

  it("keeps a comment attached to the keys it labels, rather than sorting keys into a canonical order", () => {
    const written = formatSettingsCsv(parseSettingsCsv(OWNERS_FILE).rows);
    expect(keySequence(written)).toEqual([
      '# --- the five data files ---',
      'event_url',
      'placements_url',
      'markers_url',
      'notes_url',
      'people_url',
      '# --- where the written record is versioned ---',
      'github_repo',
      'schema',
    ]);
  });

  it('adds exactly one row — schema, at the end — to a file that carries none', () => {
    const written = formatSettingsCsv(parseSettingsCsv(OWNERS_FILE).rows);
    const before = rowsOf(OWNERS_FILE);
    const after = rowsOf(written);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([['schema', '1']]);
  });

  it('leaves a schema row where its author put it', () => {
    const text = file(['schema,1', `event_url,${sheet('E')}`, 'github_repo,a/b']);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows);
    expect(keySequence(written)).toEqual(['schema', 'event_url', 'github_repo']);
  });

  it('writes a file from nothing at all', () => {
    const written = formatSettingsCsv([], {
      [settingsKeyFor('event')]: sheet('E'),
      [settingsKeyFor('notes')]: sheet('N'),
    });
    expect(rowsOf(written)).toEqual([
      ['event_url', sheet('E')],
      ['notes_url', sheet('N')],
      ['schema', '1'],
    ]);
    expect(parseSettingsCsv(written).problems).toEqual([]);
  });

  it('changes a value in place rather than moving the key to the end', () => {
    const written = formatSettingsCsv(parseSettingsCsv(OWNERS_FILE).rows, {
      event_url: sheet('REPLACED'),
    });
    expect(keySequence(written)[1]).toBe('event_url');
    expect(parseSettingsCsv(written).urls.event).toEqual([exported('REPLACED')]);
    expect(written).not.toContain(IDS.event);
  });

  it('appends a key the file does not already carry, after every row it does', () => {
    const written = formatSettingsCsv(parseSettingsCsv(OWNERS_FILE).rows, {
      github_pat_note: 'in the password manager',
    });
    const before = rowsOf(OWNERS_FILE);
    expect(rowsOf(written)).toEqual([
      ...before,
      ['github_pat_note', 'in the password manager'],
      ['schema', '1'],
    ]);
  });

  it('rewrites every row naming a key, so the file cannot say two things at once', () => {
    const text = file([`notes_url,${sheet('OLD')}`, 'github_repo,a/b', `notes_url,${sheet('OLD')}`]);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows, {
      notes_url: sheet('NEW'),
    });
    expect(rowsOf(written)).toEqual([
      ['notes_url', sheet('NEW')],
      ['github_repo', 'a/b'],
      ['notes_url', sheet('NEW')],
      ['schema', '1'],
    ]);
  });

  it('never updates a comment row, even when asked for one by name', () => {
    const text = file([`# notes_url,${sheet('DISABLED')}`, `notes_url,${sheet('LIVE')}`]);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows, {
      notes_url: sheet('NEW'),
      // A caller building updates from the rows it was handed would carry the
      // comment rows' keys along with the rest.
      '# notes_url': sheet('HIJACKED'),
    });
    expect(rowsOf(written)).toEqual([
      ['# notes_url', sheet('DISABLED')],
      ['notes_url', sheet('NEW')],
      ['schema', '1'],
    ]);
  });

  it('writes one schema row when the schema is the thing being set', () => {
    const written = formatSettingsCsv([], { schema: '1' });
    expect(rowsOf(written)).toEqual([['schema', '1']]);
    // Two of them would be a file naming a key twice, which the reader reports.
    expect(parseSettingsCsv(written).problems.filter((p) => p.includes('more than once'))).toEqual(
      [],
    );
  });

  it('gives a hand-organised file back whole: comments in place, unknown keys, ";"-lists and NFC', () => {
    // Pinned against literal rows rather than against a second read of the
    // input: comparing rowsOf(written) with rowsOf(text) puts the same reader
    // on both sides, so a reader that dropped comments would agree with itself.
    const decomposed = 'José';
    const composed = 'José';
    expect(decomposed).not.toBe(composed);
    const text = file([
      '# --- the five data files ---',
      `event_url,${sheet('E')}`,
      `notes_url,${sheet('N')} ; https://example.test/priya-notes.csv`,
      '# --- everything else ---',
      'github_repo,chendaniely/meanwhile-cm100-g',
      `author,${decomposed}`,
    ]);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows);
    expect(rowsOf(written)).toEqual([
      ['# --- the five data files ---', ''],
      ['event_url', sheet('E')],
      ['notes_url', `${sheet('N')} ; https://example.test/priya-notes.csv`],
      ['# --- everything else ---', ''],
      ['github_repo', 'chendaniely/meanwhile-cm100-g'],
      ['author', composed],
      ['schema', '1'],
    ]);
    // The ";"-list still names both files after the round trip...
    expect(parseSettingsCsv(written).urls.notes).toEqual([
      exported('N'),
      'https://example.test/priya-notes.csv',
    ]);
    // ...and writing it a second time changes not one byte.
    expect(formatSettingsCsv(parseSettingsCsv(written).rows)).toBe(written);
  });

  it('writes a key set to nothing as a blank row, because the key still records that somebody added it', () => {
    const written = formatSettingsCsv([], { markers_url: '' });
    expect(rowsOf(written)).toEqual([
      ['markers_url', ''],
      ['schema', '1'],
    ]);
  });

  it('skips a row that has no key, rather than writing a file it could not read back', () => {
    const written = formatSettingsCsv([{ key: '', value: 'orphan' } as SettingsRow]);
    expect(rowsOf(written)).toEqual([['schema', '1']]);
    expect(parseSettingsCsv(written).problems).toHaveLength(1);
  });

  it('writes the two column names and nothing else', () => {
    expect(parseCsv(formatSettingsCsv([])).headers).toEqual(['key', 'value']);
  });

  it('writes a value in composed form, so two spellings of a name are one string', () => {
    const decomposed = 'José';
    const composed = 'José';
    expect(decomposed).not.toBe(composed);
    const written = formatSettingsCsv([{ key: 'author', value: decomposed }]);
    expect(rowsOf(written)).toContainEqual(['author', composed]);
  });

  it('disarms a value a spreadsheet would run, and reads it back as it was written', () => {
    const written = formatSettingsCsv([{ key: 'github_repo', value: '=cmd|calc' }]);
    expect(written).toContain("github_repo,'=cmd|calc");
    expect(rowsOf(written)).toContainEqual(['github_repo', '=cmd|calc']);
  });

  it('keeps a value carrying a comma whole', () => {
    const written = formatSettingsCsv([{ key: 'note', value: 'event, then notes' }]);
    expect(rowsOf(written)).toContainEqual(['note', 'event, then notes']);
  });

  it("keeps a value's own spacing, so the file comes back as it was written", () => {
    const text = file(['github_repo,  chendaniely/meanwhile-cm100-g  ']);
    expect(rowsOf(text)).toContainEqual([
      'github_repo',
      '  chendaniely/meanwhile-cm100-g  ',
    ]);
    const written = formatSettingsCsv(parseSettingsCsv(text).rows);
    expect(rowsOf(written)).toContainEqual([
      'github_repo',
      '  chendaniely/meanwhile-cm100-g  ',
    ]);
  });
});

// ---------------------------------------------------------------------------
// telling settings.csv from event.csv
// ---------------------------------------------------------------------------

describe('settings.csv — telling it apart from event.csv', () => {
  it('calls a file that names a data file a settings file', () => {
    expect(keyValueCsvKind(OWNERS_FILE)).toBe('settings');
  });

  it("calls an event.csv an event file, even though course_url ends in _url", () => {
    const eventCsv = file([
      'title,Ridgeline 100',
      'timezone,America/Denver',
      'course_kind,strava-link',
      'course_url,https://www.strava.com/activities/123',
      'schema,1',
    ]);
    expect(keyValueCsvKind(eventCsv)).toBe('event');
  });

  it('calls a file carrying both signals ambiguous', () => {
    expect(keyValueCsvKind(file([`event_url,${sheet('E')}`, 'title,Ridgeline 100']))).toBe(
      'both',
    );
    expect(keyValueCsvKind(file([`notes_url,${sheet('N')}`, 'timezone,America/Denver']))).toBe(
      'both',
    );
  });

  it('calls a file carrying neither signal neither', () => {
    expect(keyValueCsvKind(file(['github_repo,a/b']))).toBe('neither');
    expect(keyValueCsvKind('')).toBe('neither');
  });

  it('does not take a key that merely contains "url" for the address of a data file', () => {
    // The signal is the "_url" SUFFIX. A key that happens to carry the letters
    // — a note about the urls, a bare "url" — names no data file, and calling
    // such a file a settings file would make the reader look for five
    // addresses that are not in it.
    expect(keyValueCsvKind(file(['urls_readme,how to fill these in']))).toBe('neither');
    expect(keyValueCsvKind(file(['url,https://example.test/']))).toBe('neither');
  });

  it('does not let a commented-out key decide what the file is', () => {
    expect(keyValueCsvKind(file([`# event_url,${sheet('E')}`, 'title,A wedding']))).toBe('event');
    expect(keyValueCsvKind(file(['# title,A wedding', `event_url,${sheet('E')}`]))).toBe(
      'settings',
    );
  });

  it('reports an event.csv handed to the settings reader instead of parsing it in silence', () => {
    const { urls, problems } = parseSettingsCsv(
      file(['title,Ridgeline 100', 'timezone,America/Denver', 'schema,1']),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('looks like an event.csv');
    expect(urls.event).toEqual([]);
  });

  it('reports a file that reads as both', () => {
    const { urls, problems } = parseSettingsCsv(
      file([`event_url,${sheet('E')}`, 'title,Ridgeline 100']),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('both a settings file and an event.csv');
    // Reported, not refused — what it does name is still read.
    expect(urls.event).toEqual([exported('E')]);
  });

  it('reports a file that names none of the five', () => {
    const { problems } = parseSettingsCsv(file(['github_repo,a/b']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('names none of the five data files');
  });
});

// ---------------------------------------------------------------------------
// the exported surface
// ---------------------------------------------------------------------------

describe('settings.csv — the surface', () => {
  it('names the five data files', () => {
    expect(DATA_FILES).toEqual(['event', 'people', 'notes', 'markers', 'placements']);
  });

  it('builds a key from a data file name', () => {
    expect(settingsKeyFor('notes')).toBe('notes_url');
    expect(settingsKeyFor('placements')).toBe('placements_url');
  });

  it('knows five addresses and a schema, and deliberately not github_repo', () => {
    expect(SETTINGS_KEYS).toEqual([
      'event_url',
      'people_url',
      'notes_url',
      'markers_url',
      'placements_url',
      'schema',
    ]);
    expect(SETTINGS_HEADERS).toEqual(['key', 'value']);
  });
});

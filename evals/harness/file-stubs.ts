/**
 * Platform stubs for behavioral evals: the picker answers with the
 * scenario's fixture, reads hand back its content, and saves, sends, and
 * stored records are captured so steps can assert on them. One synchronous
 * core serves both consumers: the TS runtime's async providers and the
 * wasm kernel's host_call.
 */

// A 2x1 png (red and blue pixels) for image scenarios.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=';

interface SavedFile {
  name: string;
  data: string;
}

interface SentEmail {
  to: string;
  subject: string;
  text: string;
  from: string;
}

interface Fixture {
  name: string;
  mime: string;
  text?: string;
  base64?: string;
  /** Repo-relative path to a committed binary fixture (media files). */
  path?: string;
}

let saved: SavedFile | null = null;
let sent: SentEmail | null = null;
let fixture: Fixture = { name: 'sample.txt', mime: 'text/plain', text: 'sample' };
let collections = new Map<string, Record<string, unknown>[]>();
let nextRecordId = 1;

// The scenario's grant table, mirroring the host: pick grants a token for
// the fixture, parts produce files that register as fresh tokens, and
// file.save resolves either back to real bytes.
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, basename } from 'node:path';

let grantDir: string | null = null;
let grants = new Map<string, string>();
let grantSeq = 1;

function grantsDir(): string {
  if (!grantDir) {
    grantDir = mkdtempSync(join(tmpdir(), 'der-eval-grants-'));
  }
  return grantDir;
}

/** Grants a real file path and answers the token, like the picker. */
export function grantPath(path: string): string {
  const token = `derfile-eval-${grantSeq++}`;
  grants.set(token, path);
  return token;
}

export function grantedPath(token: string): string | undefined {
  return grants.get(token);
}

/** The fixture as a real on-disk file, staged once per scenario. */
function fixtureFilePath(): string {
  const target = join(grantsDir(), fixture.name);
  if (!existsSync(target)) {
    if (fixture.path) {
      copyFileSync(resolvePath(fixture.path), target);
    } else if (fixture.base64) {
      writeFileSync(target, Buffer.from(fixture.base64, 'base64'));
    } else if (fixture.text !== undefined) {
      writeFileSync(target, fixture.text);
    } else {
      // A contentless binary fixture stages as the tiny png, like the
      // read stub always answered.
      writeFileSync(target, Buffer.from(TINY_PNG_BASE64, 'base64'));
    }
  }
  return target;
}

/** Takes a part-produced file into the grant table, like the host's
 * register_exec_output: the answer carries file.pick's handle shape. */
export function registerProducedFile(sourcePath: string): Record<string, unknown> {
  const name = basename(sourcePath);
  const kept = join(grantsDir(), `produced-${grantSeq}-${name}`);
  copyFileSync(sourcePath, kept);
  const token = grantPath(kept);
  const size = readFileSync(kept).length;
  return { file: token, url: `stub://produced/${name}`, name, size };
}

export function lastSavedFile(): SavedFile | null {
  return saved;
}

export function lastSentEmail(): SentEmail | null {
  return sent;
}

/** The stubbed inbox behind email.list/email.fetch in behavioral scenarios. */
const INBOX_FIXTURE = [
  {
    id: '101',
    from: 'Ada Lovelace <ada@example.org>',
    subject: 'Workshop notes',
    date: '2026-07-20',
    seen: false,
    text: 'Here are the notes from the workshop. Thanks for hosting!',
  },
  {
    id: '102',
    from: 'Sam Chen <sam@example.net>',
    subject: 'Invoice for July',
    date: '2026-07-19',
    seen: true,
    text: 'Attached is the invoice for July. Payment is due in two weeks.',
  },
];

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

function pickCore(): Record<string, unknown> {
  const path = fixtureFilePath();
  return {
    file: grantPath(path),
    url: `stub://picked/${fixture.name}`,
    name: fixture.name,
    size: readFileSync(path).length,
    mime: fixture.mime,
  };
}

function readCore(): Record<string, unknown> {
  const base64 =
    fixture.base64 ??
    (fixture.text ? Buffer.from(fixture.text, 'utf8').toString('base64') : TINY_PNG_BASE64);
  return {
    base64,
    text: fixture.text ?? null,
    name: fixture.name,
    mime: fixture.mime,
    size: fixture.text ? fixture.text.length : 128,
  };
}

function saveCore(inputs: Record<string, unknown>): Record<string, unknown> {
  // A granted handle resolves to its real bytes so fileSaved expects can
  // check magic prefixes; base64 data records as it arrived.
  const handle = str(inputs.file) || (str(inputs.data).startsWith('derfile-') ? str(inputs.data) : '');
  let data = str(inputs.data);
  if (handle) {
    const path = grantedPath(handle);
    if (!path) {
      throw new Error('file.save was handed a file handle that is not granted');
    }
    data = readFileSync(path).toString('base64');
  }
  saved = { name: str(inputs.name), data };
  return { saved: true, name: saved.name };
}

function sendCore(inputs: Record<string, unknown>): Record<string, unknown> {
  sent = {
    to: str(inputs.to),
    subject: str(inputs.subject),
    text: str(inputs.text),
    from: str(inputs.from),
  };
  return { sent: true, to: sent.to };
}

function mailListCore(): Record<string, unknown> {
  return {
    messages: INBOX_FIXTURE.map(({ text: _text, ...row }) => row),
    count: INBOX_FIXTURE.length,
  };
}

function mailFetchCore(inputs: Record<string, unknown>): Record<string, unknown> {
  const wanted = str(inputs.id);
  const message = INBOX_FIXTURE.find((m) => m.id === wanted);
  if (!message) {
    throw new Error(`No message with id ${wanted}`);
  }
  return { ...message, seen: true };
}

/** In-memory record store mirroring the host store's semantics: upsert by
 * id, loose equals, case-insensitive contains, numeric-aware sort, paging. */
function storeCore(operation: string, inputs: Record<string, unknown>): Record<string, unknown> {
  const key = str(inputs.collection);
  if (operation === 'store.put') {
    const records = collections.get(key) ?? [];
    const record = { ...((inputs.record as Record<string, unknown>) ?? {}) };
    if (record.id === undefined || record.id === null) {
      record.id = `rec-${nextRecordId++}`;
    }
    const index = records.findIndex((existing) => str(existing.id) === str(record.id));
    if (index >= 0) records[index] = record;
    else records.push(record);
    collections.set(key, records);
    return { record, count: records.length };
  }
  if (operation === 'store.remove') {
    const records = collections.get(key) ?? [];
    const before = records.length;
    const kept = records.filter((record) => str(record.id) !== str(inputs.id));
    collections.set(key, kept);
    return { removed: kept.length !== before, count: kept.length };
  }
  let records = [...(collections.get(key) ?? [])];
  const field = str(inputs.field);
  if (field) {
    const equals = str(inputs.equals);
    const contains = str(inputs.contains).toLowerCase();
    if (equals) {
      records = records.filter((record) => str(record[field]) === equals);
    } else if (contains) {
      records = records.filter((record) => str(record[field]).toLowerCase().includes(contains));
    }
  }
  const sortBy = str(inputs.sortBy);
  if (sortBy) {
    const descending = str(inputs.direction).toLowerCase() === 'desc';
    records.sort((a, b) => {
      const left = a[sortBy];
      const right = b[sortBy];
      const ln = Number(left);
      const rn = Number(right);
      const ordering =
        Number.isFinite(ln) && Number.isFinite(rn) ? ln - rn : str(left).localeCompare(str(right));
      return descending ? -ordering : ordering;
    });
  }
  const total = records.length;
  const offset = Number.parseInt(str(inputs.offset), 10) || 0;
  const limit = Number.parseInt(str(inputs.limit), 10) || 0;
  let items = records.slice(offset);
  if (limit > 0) items = items.slice(0, limit);
  return { items, count: items.length, total };
}

/** The kernel host's synchronous route into the stubbed platform. */
export function syncPlatformCall(
  operation: string,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  switch (operation) {
    case 'file.pick':
      return pickCore();
    case 'file.read':
      return readCore();
    case 'file.save':
      return saveCore(inputs);
    case 'email.send':
      return sendCore(inputs);
    case 'email.list':
      return mailListCore();
    case 'email.fetch':
      return mailFetchCore(inputs);
    case 'store.put':
    case 'store.query':
    case 'store.remove':
      return storeCore(operation, inputs);
    default:
      throw new Error(`No platform stub for ${operation}`);
  }
}

export function setupFileStubs(file?: Fixture): void {
  saved = null;
  sent = null;
  fixture = file ?? { name: 'sample.txt', mime: 'text/plain', text: 'sample' };
  collections = new Map();
  nextRecordId = 1;
  grantDir = null;
  grants = new Map();
  grantSeq = 1;
}

export function clearFileStubs(): void {
  saved = null;
  sent = null;
  collections = new Map();
}

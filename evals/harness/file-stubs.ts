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
}

let saved: SavedFile | null = null;
let sent: SentEmail | null = null;
let fixture: Fixture = { name: 'sample.txt', mime: 'text/plain', text: 'sample' };
let collections = new Map<string, Record<string, unknown>[]>();
let nextRecordId = 1;

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
  return {
    file: 'stub-file-token',
    url: `stub://picked/${fixture.name}`,
    name: fixture.name,
    size: fixture.text ? fixture.text.length : 128,
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
  // A produced-file handle saves by reference; base64 data saves inline.
  // The recorded data field carries whichever arrived, so expects can
  // match on either.
  const handle = str(inputs.file) || (str(inputs.data).startsWith('derfile-') ? str(inputs.data) : '');
  saved = { name: str(inputs.name), data: handle || str(inputs.data) };
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
}

export function clearFileStubs(): void {
  saved = null;
  sent = null;
  collections = new Map();
}

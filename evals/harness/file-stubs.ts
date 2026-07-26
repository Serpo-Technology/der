/**
 * Platform stubs for behavioral evals: the picker answers with the
 * scenario's fixture, reads hand back its content, and saves and sends
 * record what landed so steps can assert on it. No dialogs or SMTP under
 * jsdom.
 */

import {
  setEmailProvider,
  setFileOpProviders,
  setMailProviders,
} from '../../src/services/operations/registry';

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

let saved: SavedFile | null = null;
let sent: SentEmail | null = null;

export function lastSavedFile(): SavedFile | null {
  return saved;
}

export function lastSentEmail(): SentEmail | null {
  return sent;
}

/** The stubbed inbox behind mail.list/mail.fetch in behavioral scenarios. */
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

export function setupFileStubs(
  file?: { name: string; mime: string; text?: string; base64?: string }
): void {
  saved = null;
  sent = null;
  setEmailProvider(async (inputs) => {
    sent = {
      to: String(inputs.to ?? ''),
      subject: String(inputs.subject ?? ''),
      text: String(inputs.text ?? ''),
      from: String(inputs.from ?? ''),
    };
    return { sent: true, to: sent.to };
  });
  setMailProviders({
    list: async () => ({
      messages: INBOX_FIXTURE.map(({ text: _text, ...row }) => row),
      count: INBOX_FIXTURE.length,
    }),
    fetch: async (inputs) => {
      const wanted = String(inputs.id ?? '');
      const message = INBOX_FIXTURE.find((m) => m.id === wanted);
      if (!message) {
        throw new Error(`No message with id ${wanted}`);
      }
      const { text, ...rest } = message;
      return { ...rest, text, seen: true };
    },
  });
  const fixture = file ?? { name: 'sample.txt', mime: 'text/plain', text: 'sample' };
  const base64 =
    fixture.base64 ??
    (fixture.text ? Buffer.from(fixture.text, 'utf8').toString('base64') : TINY_PNG_BASE64);
  setFileOpProviders({
    pick: async () => ({
      file: 'stub-file-token',
      url: `stub://picked/${fixture.name}`,
      name: fixture.name,
      size: fixture.text ? fixture.text.length : 128,
      mime: fixture.mime,
    }),
    read: async () => ({
      base64,
      text: fixture.text ?? null,
      name: fixture.name,
      mime: fixture.mime,
      size: fixture.text ? fixture.text.length : 128,
    }),
    save: async (inputs) => {
      saved = {
        name: String(inputs.name ?? ''),
        data: String(inputs.data ?? ''),
      };
      return { saved: true, name: saved.name };
    },
  });
}

export function clearFileStubs(): void {
  saved = null;
  sent = null;
  setFileOpProviders({});
  setEmailProvider(undefined);
  setMailProviders({});
}

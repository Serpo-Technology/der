/**
 * Scripted-interaction engine for behavioral evals. Steps address controls
 * by fuzzy hints (label, placeholder, id, button text) because generated
 * contracts choose their own ids and wording; assertions check rendered
 * text, the same surface a person judges.
 */

import { fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';

export interface BehaviorStep {
  do?: 'type' | 'select' | 'click' | 'clickRow' | 'clickInRow' | 'toggleInRow' | 'wait';
  into?: string | string[];
  in?: string | string[];
  on?: string | string[];
  row?: string;
  value?: string;
  ms?: number;
  optional?: boolean;
  expect?: 'text' | 'noText' | 'rowCount' | 'viewer' | 'fileSaved' | 'emailSent' | 'selector';
  match?: string;
  count?: number;
  /** fileSaved: the saved base64 must start with this (a magic-byte check). */
  dataPrefix?: string;
  /** selector: a CSS selector that must match at least `min` nodes. */
  selector?: string;
  min?: number;
}

export interface BehaviorScenario {
  stubs?: Record<string, Record<string, unknown>>;
  /** The file the stubbed picker answers with. */
  file?: { name: string; mime: string; text?: string; base64?: string };
  steps: BehaviorStep[];
}

import { lastSavedFile, lastSentEmail } from './file-stubs';

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

function hints(h: string | string[] | undefined): string[] {
  if (!h) return [];
  return (Array.isArray(h) ? h : [h]).map(norm).filter(Boolean);
}

function score(candidate: string, hint: string): number {
  const c = norm(candidate);
  if (!c || !hint) return 0;
  if (c === hint) return 3;
  if (c.startsWith(hint)) return 2;
  if (c.includes(hint)) return 1;
  // "Eval" should satisfy a hint of "evaluate": short labels count too.
  if (c.length >= 3 && hint.includes(c)) return 1;
  return 0;
}

/** Visible text with spaces between nodes; textContent glues "10" to
 * "Delete" across elements, which defeats word-boundary matching. */
function visibleText(root: HTMLElement): string {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  while (walker.nextNode()) {
    const value = walker.currentNode.nodeValue?.trim();
    if (value) parts.push(value);
  }
  return parts.join(' ');
}

/** Texts a control can be addressed by: its label, placeholder, names. */
function controlLabels(el: Element): string[] {
  const labels: string[] = [];
  const wrapping = el.closest('label');
  if (wrapping) {
    for (const span of wrapping.querySelectorAll('span')) {
      labels.push(span.textContent ?? '');
    }
  }
  const attrs = ['placeholder', 'aria-label', 'id', 'name', 'title', 'data-element-id'];
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (value) labels.push(value);
  }
  return labels;
}

function bestMatch<T extends Element>(
  candidates: T[],
  labelsOf: (el: T) => string[],
  wanted: string[]
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const labels = labelsOf(el);
    let s = 0;
    for (const hint of wanted) {
      for (const label of labels) {
        s = Math.max(s, score(label, hint));
      }
    }
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  return best;
}

function describeCandidates(candidates: Element[], labelsOf: (el: Element) => string[]): string {
  return candidates
    .map((el) => labelsOf(el).filter(Boolean).slice(0, 3).join('|') || el.tagName.toLowerCase())
    .join(', ');
}

function findInput(root: HTMLElement, wanted: string[]): HTMLElement {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input:not([type=checkbox]):not([type=radio]), textarea'
    )
  );
  const found = wanted.length
    ? bestMatch(candidates, controlLabels, wanted)
    : candidates[0] ?? null;
  if (!found) {
    throw new Error(
      `No input matches ${JSON.stringify(wanted)}; inputs here: ${describeCandidates(candidates, controlLabels)}`
    );
  }
  return found;
}

function findSelect(root: HTMLElement, wanted: string[]): HTMLSelectElement {
  const candidates = Array.from(root.querySelectorAll<HTMLSelectElement>('select'));
  // Apps often label a data-entry select and its filter twin identically
  // ("Category"). The entry select sits in a container with text inputs;
  // the filter select does not. Break label ties on that context.
  let best: HTMLSelectElement | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    let s = 0;
    for (const hint of wanted) {
      for (const label of controlLabels(el)) {
        s = Math.max(s, score(label, hint));
      }
    }
    if (s > 0 && el.closest('div[data-element-id]')?.querySelector('input:not([type=checkbox])')) {
      s += 0.5;
    }
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  const found = wanted.length ? best : candidates[0] ?? null;
  if (!found) {
    throw new Error(
      `No select matches ${JSON.stringify(wanted)}; selects here: ${describeCandidates(candidates, controlLabels)}`
    );
  }
  return found;
}

function buttonLabels(el: Element): string[] {
  return [el.textContent ?? '', ...controlLabels(el)];
}

function findButton(root: HTMLElement, wanted: string[]): HTMLElement {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('button'));
  const found = bestMatch(candidates, buttonLabels, wanted);
  if (!found) {
    throw new Error(
      `No button matches ${JSON.stringify(wanted)}; buttons here: ${describeCandidates(candidates, buttonLabels)}`
    );
  }
  return found;
}

function findRow(root: HTMLElement, hint: string): HTMLElement {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('li'));
  const found = rows.find((row) => norm(row.textContent).includes(norm(hint)));
  if (!found) {
    throw new Error(
      `No row contains "${hint}"; rows here: ${rows.map((r) => norm(r.textContent).slice(0, 40)).join(' / ') || '(none)'}`
    );
  }
  return found;
}

function toMatcher(match: string): (text: string) => boolean {
  const templated = match.replace('{{year}}', String(new Date().getFullYear()));
  const asRegex = /^\/(.+)\/([a-z]*)$/.exec(templated);
  if (asRegex) {
    const re = new RegExp(asRegex[1], asRegex[2] || undefined);
    return (text) => re.test(text);
  }
  return (text) => norm(text).includes(norm(templated));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function runOne(step: BehaviorStep, root: HTMLElement): Promise<void> {
  if (step.expect) {
    const text = () => visibleText(root);
    if (step.expect === 'text') {
      const matches = toMatcher(step.match ?? '');
      await waitFor(() => {
        if (!matches(text())) {
          throw new Error(`Expected visible text matching ${JSON.stringify(step.match)}; got: ${text().slice(0, 300)}`);
        }
      }, { timeout: 4000 });
    } else if (step.expect === 'noText') {
      await settle();
      const matches = toMatcher(step.match ?? '');
      if (matches(text())) {
        throw new Error(`Expected NO visible text matching ${JSON.stringify(step.match)}; got: ${text().slice(0, 300)}`);
      }
    } else if (step.expect === 'rowCount') {
      await waitFor(() => {
        const n = root.querySelectorAll('li').length;
        if (n !== step.count) {
          throw new Error(
            `Expected ${step.count} rows, found ${n}; page: ${text().slice(0, 300)}`
          );
        }
      }, { timeout: 4000 });
    } else if (step.expect === 'viewer') {
      // A media element wired up: some embed/video/img carries a src.
      const matches = toMatcher(step.match ?? '');
      await waitFor(() => {
        const sources = Array.from(
          root.querySelectorAll<HTMLElement>('embed, video, img')
        ).map((node) => node.getAttribute('src') ?? '');
        if (!sources.some((src) => src.length > 0 && matches(src))) {
          throw new Error(
            `Expected a viewer with src matching ${JSON.stringify(step.match)}; sources: ${JSON.stringify(sources)}`
          );
        }
      }, { timeout: 4000 });
    } else if (step.expect === 'selector') {
      await waitFor(() => {
        const found = root.querySelectorAll(step.selector ?? '').length;
        if (found < (step.min ?? 1)) {
          throw new Error(
            `Expected at least ${step.min ?? 1} nodes for ${JSON.stringify(step.selector)}; found ${found}`
          );
        }
      }, { timeout: 4000 });
    } else if (step.expect === 'fileSaved') {
      const matches = toMatcher(step.match ?? '');
      await waitFor(() => {
        const saved = lastSavedFile();
        if (!saved) {
          throw new Error('Expected file.save to have run; nothing was saved');
        }
        if (step.match && !matches(saved.name)) {
          throw new Error(
            `Expected the saved name to match ${JSON.stringify(step.match)}; got: ${saved.name}`
          );
        }
        if (step.dataPrefix && !saved.data.startsWith(step.dataPrefix)) {
          throw new Error(
            `Expected saved data starting with ${step.dataPrefix}; got: ${saved.data.slice(0, 24)}`
          );
        }
      }, { timeout: 4000 });
    } else if (step.expect === 'emailSent') {
      const matches = toMatcher(step.match ?? '');
      await waitFor(() => {
        const mail = lastSentEmail();
        if (!mail) {
          throw new Error('Expected email.send to have run; nothing was sent');
        }
        const surface = `${mail.to} ${mail.subject} ${mail.text}`;
        if (step.match && !matches(surface)) {
          throw new Error(
            `Expected the sent email to match ${JSON.stringify(step.match)}; got: ${surface.slice(0, 120)}`
          );
        }
      }, { timeout: 4000 });
    }
    return;
  }

  switch (step.do) {
    case 'type': {
      const input = findInput(root, hints(step.into));
      fireEvent.change(input, { target: { value: step.value ?? '' } });
      break;
    }
    case 'select': {
      const select = findSelect(root, hints(step.in));
      const options = Array.from(select.querySelectorAll('option'));
      const wanted = norm(step.value);
      const option =
        options.find((o) => norm(o.value) === wanted || norm(o.textContent) === wanted) ??
        options.find((o) => norm(o.value).includes(wanted) || norm(o.textContent).includes(wanted));
      if (!option) {
        throw new Error(
          `Select has no option like "${step.value}"; options: ${options.map((o) => o.value || o.textContent).join(', ')}`
        );
      }
      fireEvent.change(select, { target: { value: option.value } });
      break;
    }
    case 'click':
      fireEvent.click(findButton(root, hints(step.on)));
      break;
    case 'clickRow': {
      // Contracts may bind the click on the row's inner text rather than the
      // row itself; firing on the deepest addressable child bubbles through
      // both.
      const row = findRow(root, step.row ?? '');
      fireEvent.click(row.querySelector('[data-element-id]') ?? row);
      break;
    }
    case 'clickInRow': {
      const row = findRow(root, step.row ?? '');
      fireEvent.click(findButton(row, hints(step.on)));
      break;
    }
    case 'toggleInRow': {
      const row = findRow(root, step.row ?? '');
      const checkbox = row.querySelector<HTMLElement>('input[type=checkbox]');
      if (checkbox) {
        fireEvent.click(checkbox);
      } else {
        fireEvent.click(findButton(row, hints(step.on ?? ['complete', 'done', 'finish', 'toggle', 'mark'])));
      }
      break;
    }
    case 'wait':
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, step.ms ?? 0));
      });
      break;
    default:
      throw new Error(`Unknown step: ${JSON.stringify(step)}`);
  }
  await settle();
}

export async function runScenario(scenario: BehaviorScenario, root: HTMLElement): Promise<void> {
  // State initialization is asynchronous; the first paint can be empty.
  await waitFor(() => {
    if (!root.querySelector('[data-element-id]')) {
      throw new Error('Experience did not render any elements');
    }
  }, { timeout: 4000 });
  await settle();

  for (const [index, step] of scenario.steps.entries()) {
    try {
      await runOne(step, root);
    } catch (error) {
      if (step.optional) continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Step ${index + 1} ${JSON.stringify(step)}: ${message}`);
    }
  }
}

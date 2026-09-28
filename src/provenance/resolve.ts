import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createIndex, record, scan, type ElementRef, type ProvenanceIndex } from './plugin.ts';

export type ResolvedElement = {
  id: string;
  tag: string;
  attributes: Record<string, string>;
  file: string;
  line: number;
  column: number;
  /** The source text of the element, for showing the user what they picked. */
  snippet: string;
};

/**
 * Rebuilds the provenance index from disk.
 *
 * The plugin lives inside the dev server's process, so the daemon cannot share
 * its in-memory index. Re-deriving here keeps the two from having to share a
 * channel at all, and it works even when no dev server is running — which is
 * exactly when someone is most likely to be reading source.
 */
export async function buildIndex(dir: string): Promise<ProvenanceIndex> {
  const index = createIndex();
  for (const file of await collectSources(dir)) {
    const code = await readFile(file, 'utf8').catch(() => null);
    if (code === null) continue;
    const result = scan(code, file);
    if (result.elements.length) record(index, file, result.elements);
  }
  return index;
}

const SOURCE_DIRS = ['src', 'app', 'components', 'pages', 'templates', 'views', 'lib'];
const SOURCE_EXT = /\.(jsx?|tsx?|svelte|vue|astro)$/;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.kiln|\.next|coverage|vendor)(\/|$)/;

async function collectSources(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.test(path) || !SOURCE_DIRS.includes(entry.name)) continue;
      files.push(...(await collectSources(path, depth + 1)));
    } else if (SOURCE_EXT.test(entry.name) && !/\.d\.ts$|\.test\.|\.spec\./.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

export function lookup(index: ProvenanceIndex, id: string): ElementRef | null {
  return index.byId.get(id) ?? null;
}

export function nearest(index: ProvenanceIndex, file: string, line: number): ElementRef | null {
  let best: ElementRef | null = null;
  for (const element of index.byFile.get(file) ?? []) {
    const ref = index.byId.get(element);
    if (!ref) continue;
    if (ref.line <= line && (!best || ref.line > best.line)) best = ref;
  }
  return best;
}

/**
 * Turns a selection into an instruction the agent can act on without guessing.
 * The difference between "make that button red" and a named file, line and
 * current attributes is most of the difference between a good edit and a
 * confident wrong one.
 */
export function describeEdit(element: ResolvedElement, intent: string): string {
  const attributes = Object.entries(element.attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');

  return [
    `Edit the element at ${element.file}:${element.line} (column ${element.column}).`,
    '',
    `It is a <${element.tag}>.`,
    attributes ? `Its current attributes are: ${attributes}` : 'It currently has no attributes.',
    '',
    'Current source:',
    '```',
    element.snippet.trim(),
    '```',
    '',
    `Requested change: ${intent}`,
    '',
    'Edit only that element. Do not restructure anything around it, and do not change',
    'unrelated files.',
  ].join('\n');
}

export async function snippetFor(file: string, line: number, span = 3): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null || !existsSync(file)) return '';
  const lines = text.split('\n');
  const from = Math.max(0, line - 1 - span);
  const to = Math.min(lines.length, line + span);
  return lines.slice(from, to).join('\n');
}

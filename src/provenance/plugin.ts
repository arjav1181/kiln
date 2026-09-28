import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as acorn from 'acorn';
import acornJsx from 'acorn-jsx';

const JsxParser = acorn.Parser.extend(acornJsx());

export type ElementRef = {
  id: string;
  file: string;
  line: number;
  column: number;
  tag: string;
  attributes: Record<string, string>;
};

export type ProvenanceIndex = {
  /** Bumped on every transform, so clients know to refetch. */
  version: number;
  byId: Map<string, ElementRef>;
  byFile: Map<string, Set<string>>;
};

export function createIndex(): ProvenanceIndex {
  return { version: 0, byId: new Map(), byFile: new Map() };
}

/**
 * Ids derive from position plus the element's own shape rather than a counter,
 * so a re-transform of unchanged code reproduces them, and a rewritten file
 * yields new ids instead of stale ones pointing at the wrong element.
 *
 * Position alone is not enough: after a rewrite a different element can land on
 * the same line and column, and a position-only id would silently re-point a
 * user's selection at it. Folding in tag and attributes removes that.
 */
function makeId(file: string, line: number, column: number, tag: string, attributes: Record<string, string>): string {
  const shape = Object.keys(attributes)
    .sort()
    .map((key) => `${key}=${attributes[key]}`)
    .join(' ');
  return createHash('sha1')
    .update(`${file}:${line}:${column}:${tag}:${shape}`)
    .digest('hex')
    .slice(0, 12);
}

const TSX_EXT = /\.[jt]sx$/;

type JsxNode = {
  type: string;
  start: number;
  end: number;
  name?: { start: number; end: number; type: string; name?: string; object?: unknown; property?: unknown };
  attributes?: Array<{ type: string; name?: { name?: string }; value?: { value?: unknown } | null }>;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
};

function tagName(node: JsxNode): string {
  const name = node.name;
  if (!name) return 'unknown';
  if (name.type === 'JSXIdentifier') return name.name ?? 'unknown';
  const object = name.object as JsxNode | undefined;
  const property = name.property as JsxNode | undefined;
  if (object && property) return `${tagName(object)}.${tagName(property)}`;
  return 'unknown';
}

function staticAttributes(node: JsxNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== 'JSXAttribute') continue;
    const key = attribute.name?.name;
    if (!key) continue;
    const value = attribute.value as { value?: unknown } | null;
    out[key] = value && typeof value.value === 'string' ? value.value : 'true';
  }
  return out;
}

export type ScanResult = {
  code: string;
  elements: ElementRef[];
  /** True when the file already carried ids from a previous transform. */
  alreadyInstrumented: boolean;
};

export function scan(code: string, file: string): ScanResult {
  const alreadyInstrumented = code.includes('data-kiln-id');
  if (alreadyInstrumented) return { code, elements: [], alreadyInstrumented };

  let ast: unknown;
  try {
    ast = JsxParser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });
  } catch {
    // Unparseable modules are left alone rather than breaking the dev server.
    return { code, elements: [], alreadyInstrumented };
  }

  const elements: ElementRef[] = [];
  const edits: Array<{ at: number; id: string }> = [];

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const current = node as JsxNode;

    if (current.type === 'JSXOpeningElement' || current.type === 'JSXSelfClosingElement') {
      const name = current.name;
      const line = current.loc?.start;
      if (name && line) {
        const tag = tagName(current);
        const attributes = staticAttributes(current);
        const id = makeId(file, line.line, line.column, tag, attributes);
        edits.push({ at: name.end, id });
        elements.push({
          id,
          file,
          line: line.line,
          column: line.column,
          tag,
          attributes,
        });
      }
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };

  visit(ast);

  let out = code;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, edit.at)} data-kiln-id="${edit.id}"${out.slice(edit.at)}`;
  }

  return { code: out, elements, alreadyInstrumented };
}

/** Records a module's elements into the shared index. */
export function record(index: ProvenanceIndex, file: string, elements: ElementRef[]): void {
  const previous = index.byFile.get(file);
  if (previous) for (const id of previous) index.byId.delete(id);

  const ids = new Set<string>();
  for (const element of elements) {
    index.byId.set(element.id, element);
    ids.add(element.id);
  }
  index.byFile.set(file, ids);
  index.version += 1;
}

export function forget(index: ProvenanceIndex, file: string): void {
  const previous = index.byFile.get(file);
  if (!previous) return;
  for (const id of previous) index.byId.delete(id);
  index.byFile.delete(file);
  index.version += 1;
}

export type ProvenancePlugin = {
  name: string;
  /**
   * Must run before `vite:esbuild`, which would otherwise strip the JSX this
   * plugin parses.
   */
  enforce: 'pre';
  transform: (code: string, id: string) => { code: string } | null;
  handleHotUpdate: (context: { file: string }) => void;
  index: ProvenanceIndex;
};

export type ProvenanceOptions = {
  /**
   * Where to publish the index. The plugin runs inside the dev-server child
   * process, so the daemon cannot read it in memory; a file is the simplest
   * channel and a unix socket is the production one.
   */
  outFile?: string;
};

export function provenancePlugin(options: ProvenanceOptions = {}): ProvenancePlugin {
  const index = createIndex();

  const publish = () => {
    if (!options.outFile) return;
    const payload = JSON.stringify({ version: index.version, elements: [...index.byId.values()] }, null, 2);
    // Write-then-rename: a reader polling this file must never observe a
    // half-written snapshot.
    const temp = `${options.outFile}.${process.pid}.tmp`;
    mkdirSync(dirname(options.outFile), { recursive: true });
    writeFileSync(temp, payload);
    renameSync(temp, options.outFile);
  };

  return {
    name: 'kiln:provenance',
    enforce: 'pre',
    index,

    transform(code: string, id: string) {
      const file = id.split('?')[0] ?? id;
      if (!TSX_EXT.test(file)) return null;
      if (file.includes('/node_modules/')) return null;

      const result = scan(code, file);
      if (!result.elements.length) return null;

      record(index, file, result.elements);
      publish();
      return { code: result.code };
    },

    handleHotUpdate({ file }) {
      if (!TSX_EXT.test(file)) return;
      index.version += 1;
      publish();
    },
  };
}

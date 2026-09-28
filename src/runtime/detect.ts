import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type DevTarget = {
  command: string;
  args: string[];
  framework: string;
  /** Ports to try when the process does not announce a URL. */
  ports: number[];
};

type Matcher = {
  framework: string;
  command: string;
  args?: string[];
  ports?: number[];
  detect: (dir: string) => boolean | Promise<boolean>;
};

const has = (dir: string, ...files: string[]) => files.some((f) => existsSync(join(dir, f)));

async function readsPackage(dir: string, relative: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(dir, relative), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function nodeTarget(dir: string): Promise<DevTarget | null> {
  const pkg = await readsPackage(dir, 'package.json');
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve;
  if (!scriptName) return null;

  const runner = has(dir, 'bun.lock', 'bun.lockb')
    ? 'bun'
    : has(dir, 'pnpm-lock.yaml')
      ? 'pnpm'
      : has(dir, 'yarn.lock')
        ? 'yarn'
        : 'npm';

  return {
    command: runner,
    args: ['run', scriptName],
    framework: `node:${runner}`,
    ports: [5173, 3000, 8080, 4200, 8000],
  };
}

const MATCHERS: Matcher[] = [
  {
    framework: 'python:django',
    command: 'python',
    args: ['manage.py', 'runserver'],
    ports: [8000],
    detect: (dir) => has(dir, 'manage.py'),
  },
  {
    framework: 'python:flask',
    command: 'flask',
    args: ['run', '--port', '5000'],
    ports: [5000],
    detect: async (dir) => {
      if (!has(dir, 'app.py', 'wsgi.py')) return false;
      const deps = `${await readFile(join(dir, 'requirements.txt'), 'utf8').catch(() => '')}${await readFile(join(dir, 'pyproject.toml'), 'utf8').catch(() => '')}`;
      return /flask/i.test(deps);
    },
  },
  {
    framework: 'go',
    command: 'go',
    args: ['run', '.'],
    ports: [8080, 3000, 8000],
    detect: (dir) => has(dir, 'go.mod'),
  },
  {
    framework: 'elixir:phoenix',
    command: 'mix',
    args: ['phx.server'],
    ports: [4000],
    detect: (dir) => has(dir, 'mix.exs'),
  },
  {
    framework: 'docker:compose',
    command: 'docker',
    args: ['compose', 'up'],
    ports: [3000, 8080, 8000],
    detect: (dir) => has(dir, 'docker-compose.yml', 'compose.yaml'),
  },
  {
    framework: 'static',
    command: 'npx',
    args: ['--yes', 'serve', '.', '-l', '5050'],
    ports: [5050],
    detect: (dir) => has(dir, 'index.html') && !has(dir, 'package.json'),
  },
];

/**
 * Best-effort guess at how to serve this project. Returns null for stacks we do
 * not recognise, which is a supported outcome: the caller asks the user for a
 * command instead of guessing.
 */
export async function detectDevServer(dir: string): Promise<DevTarget | null> {
  const node = await nodeTarget(dir);
  if (node) return node;

  for (const matcher of MATCHERS) {
    if (await matcher.detect(dir)) {
      return {
        command: matcher.command,
        args: matcher.args ?? [],
        framework: matcher.framework,
        ports: matcher.ports ?? [3000],
      };
    }
  }
  return null;
}

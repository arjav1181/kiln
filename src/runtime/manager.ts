import { type ChildProcess, spawn } from 'node:child_process';
import { detectDevServer, type DevTarget } from './detect.ts';
import { isVite, wrapViteConfig } from './vite.ts';

export type DevServer = {
  url: string;
  port: number;
  framework: string;
  logs: () => string[];
  stop: () => void;
};

export type StartOptions = {
  cwd: string;
  /** Overrides detection. This is how an unrecognised stack still works. */
  target?: { command: string; args?: string[] };
  readyTimeoutMs?: number;
  onLog?: (line: string) => void;
};

const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i;
const PORT_IN_URL = /:(\d{2,5})\b/;
// Plenty of servers announce a bare host:port with no scheme, e.g. Go's
// `listening on 127.0.0.1:5277`.
const BARE_HOST_PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/;
// Others announce only the number, e.g. `listening on 44919`. Anchoring on the
// surrounding words keeps this from matching unrelated digits.
const ANNOUNCED_PORT = /\b(?:port|listening on|listening at|address|bound to|now on)\b[^\d]{0,12}(\d{2,5})\b/i;
// Dev servers colour their output even when piped, and the escapes land inside
// the URL, so strip before matching.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for the process to announce its port before guessing. */
const ANNOUNCE_GRACE_MS = 12_000;

function announcedPort(line: string): number | null {
  const url = line.match(URL_IN_LOG)?.[0];
  const fromUrl = url?.match(PORT_IN_URL)?.[1];
  if (fromUrl) return Number(fromUrl);

  const host = line.match(BARE_HOST_PORT)?.[1];
  if (host) return Number(host);

  const bare = line.match(ANNOUNCED_PORT)?.[1];
  return bare ? Number(bare) : null;
}

async function isServing(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Resolves the port once something actually answers.
 *
 * A URL the process announced always wins: guessing a port early can latch the
 * preview onto an unrelated service already listening on 3000 or 8000. Guessed
 * candidates are only tried once the announcement grace period has passed.
 */
async function waitForServing(
  announced: () => number | null,
  candidates: number[],
  isDead: () => boolean,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const guessAfter = Date.now() + ANNOUNCE_GRACE_MS;

  while (Date.now() < deadline) {
    if (isDead()) return null;

    const claimed = announced();
    if (claimed !== null && (await isServing(`http://127.0.0.1:${claimed}/`))) return claimed;

    if (Date.now() >= guessAfter) {
      for (const port of candidates) {
        if (await isServing(`http://127.0.0.1:${port}/`)) return port;
      }
    }

    await sleep(250);
  }

  return null;
}

const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Appends arguments to a dev command. Package-manager runners swallow bare
 * flags, so `npm run dev --config x` would never reach vite; the separator is
 * what makes `npm run dev -- --config x` work.
 */
function withExtraArgs(command: string, args: string[], extra: string[]): string[] {
  if (RUNNERS.has(command) && args[0] === 'run') return [...args, '--', ...extra];
  return [...args, ...extra];
}

export async function startDevServer(options: StartOptions): Promise<DevServer> {
  const { cwd, onLog } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;

  const detected: DevTarget | null = options.target
    ? { ...options.target, args: options.target.args ?? [], framework: 'user', ports: [] }
    : await detectDevServer(cwd);

  if (!detected) {
    throw new Error(
      'Could not work out how to run this project. Kiln needs a dev command, ' +
        'for example `npm run dev`.',
    );
  }

  let args = detected.args;
  // Vite projects get Kiln's provenance plugin through a generated wrapper
  // config, so the project itself is never modified and `npm run dev` keeps
  // working normally without it.
  if (!options.target && isVite(cwd)) {
    try {
      const wrap = await wrapViteConfig(cwd);
      if (wrap) args = withExtraArgs(detected.command, args, wrap.args);
    } catch (error) {
      // Not fatal: without the wrapper the project still previews, it just
      // falls back to source-search provenance.
      options.onLog?.(`[kiln] provenance unavailable: ${(error as Error).message}`);
    }
  }

  const lines: string[] = [];
  let announced: number | null = null;

  const child: ChildProcess = spawn(detected.command, args, {
    cwd,
    env: { ...process.env, BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Dev servers spawn children (npm -> vite); kill the group so we never
    // leave an orphan holding the port.
    detached: true,
  });

  let dead = false;
  // Without this, a missing binary (no npm, no npx) surfaces as an unhandled
  // 'error' event instead of a message the user can act on.
  const spawnError = new Promise<never>((_, reject) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      dead = true;
      reject(
        error.code === 'ENOENT'
          ? new Error(`\`${detected.command}\` is not installed or not on your PATH.`)
          : error,
      );
    });
  });
  child.on('exit', () => {
    dead = true;
  });

  // Signal the whole process group even if the direct child has already exited:
  // `npm run vite` can exit while vite itself keeps holding the port.
  const killTree = () => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    const escalate = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, which is the common case.
      }
    }, 2000);
    escalate.unref?.();
  };

  const record = (chunk: Buffer) => {
    for (const raw of chunk.toString().split('\n')) {
      const text = raw.replace(ANSI, '').trim();
      if (!text) continue;
      lines.push(text);
      onLog?.(text);
      if (announced !== null) continue;
      const port = announcedPort(text);
      if (port !== null) announced = port;
    }
  };

  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  const port = await Promise.race([
    waitForServing(() => announced, detected.ports, () => dead, readyTimeoutMs),
    spawnError,
  ]);

  if (port === null) {
    const command = `${detected.command} ${args.join(' ')}`.trim();
    killTree();
    throw new Error(
      `Dev server (${command}) did not start serving within ${readyTimeoutMs / 1000}s.\n\n` +
        lines.slice(-15).join('\n'),
    );
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    framework: detected.framework,
    logs: () => [...lines],
    stop: killTree,
  };
}

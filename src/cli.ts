#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { App } from './daemon/app.ts';
import { createDaemon } from './daemon/server.ts';
import { detectDevServer } from './runtime/detect.ts';

const HELP = `
kiln — a Lovable-grade shell for terminal coding agents

  kiln [directory] [options]

  --port <n>        daemon port (default: random free port)
  --dev <command>   dev command to run, instead of detecting one
  --model <id>      model id to hand to the agent
  --no-open         do not open a browser
  --headless        run without the capture browser
  --auto-approve    allow every tool the agent asks for (unsafe)
  --verbose, -v     stream every event, tool call and result to the terminal
  --help            show this

Start from an empty directory and the first turn scaffolds the app.
`;

type Options = {
  dir: string;
  port: number;
  dev?: string;
  model?: string;
  open: boolean;
  headless: boolean;
  autoApprove: boolean;
  verbose: boolean;
  help: boolean;
};

function parse(argv: string[]): Options {
  const options: Options = {
    dir: process.cwd(),
    port: 0,
    open: true,
    headless: false,
    autoApprove: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--dev') options.dev = next();
    else if (arg === '--model') options.model = next();
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--auto-approve') options.autoApprove = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.dir = resolve(arg);
  }

  if (!Number.isInteger(options.port) || options.port < 0) {
    throw new Error('--port must be a number');
  }
  return options;
}

function openBrowser(url: string): void {
  const candidates =
    process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['start', ''] : ['xdg-open'];
  try {
    spawn(candidates[0]!, [...candidates.slice(1), url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Headless machines have no opener; the URL is printed either way.
  }
}

async function ensureKilnDir(dir: string): Promise<void> {
  await mkdir(resolve(dir, '.kiln'), { recursive: true });
  const config = resolve(dir, '.kiln', 'config.json');
  if (!existsSync(config)) {
    await writeFile(config, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  }
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREY = '\x1b[90m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function line(colour: string, kind: string, text = '') {
  process.stdout.write(`${DIM}${stamp()}${RESET} ${colour}${kind.padEnd(16)}${RESET} ${text}\n`);
}

/**
 * Mirrors the daemon onto the terminal. The browser shows the same events, but
 * a terminal session should not need one to see what the agent is doing.
 */
function attachVerboseStream(app: App): void {
  app.subscribe((event) => {
    const e = event as Record<string, unknown> & { kind: string };
    switch (e.kind) {
      case 'turn.start':
        line(CYAN, 'turn', `started ${String(e.turnId).slice(0, 8)}`);
        break;
      case 'text':
        process.stdout.write(String(e.delta));
        break;
      case 'thinking':
        line(DIM, 'thinking', truncate(String(e.delta), 100));
        break;
      case 'tool.start':
        line(GREY, 'tool', `${String(e.name)} ${truncate(JSON.stringify(e.input ?? {}), 160)}`);
        break;
      case 'tool.result':
        line(e.isError ? RED : GREY, e.isError ? 'tool failed' : 'tool ok', truncate(String(e.output ?? ''), 160));
        break;
      case 'turn.end':
        process.stdout.write('\n');
        line(CYAN, 'turn end', `${String(e.stopReason)} · $${Number(e.costUsd).toFixed(4)}`);
        break;
      case 'turn.done': {
        const files = (e.files as string[]) ?? [];
        line(GREEN, 'checkpoint', `${String(e.checkpointId ?? 'none').slice(0, 8)} · ${files.length} files`);
        break;
      }
      case 'turn.retrying':
        line(RED, 'retrying', String(e.reason));
        break;
      case 'permission':
        line(RED, 'permission', `${String(e.title)} — answer it in the browser`);
        break;
      case 'question':
        line(RED, 'question', String(e.question));
        break;
      case 'server.log':
        line(DIM, 'server', String(e.line));
        break;
      case 'preview':
        line(GREEN, 'preview', `${String(e.url)} (${String(e.framework)})`);
        break;
      case 'preview.captured':
        line(GREEN, 'screenshot', String(e.reason));
        break;
      case 'preview.skipped':
        line(DIM, 'screenshot skipped', String(e.reason));
        break;
      case 'preview.log':
        line(RED, 'page error', String(e.text));
        break;
      case 'deps.starting':
        line(GREY, 'install', `${String(e.manager)} dependencies`);
        break;
      case 'deps.done':
        line(e.ok ? GREEN : RED, e.ok ? 'installed' : 'install failed', String(e.detail ?? ''));
        break;
      case 'history.disabled':
        line(RED, 'history off', String(e.reason));
        break;
      case 'session.ready':
        line(DIM, 'session', String(e.sessionId));
        break;
      case 'busy':
        if (e.busy) line(CYAN, 'working', '');
        break;
      case 'fatal':
        line(RED, 'fatal', String(e.message));
        break;
    }
  });
}

const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  await ensureKilnDir(options.dir);

  const app = new App({
    dir: options.dir,
    model: options.model ?? process.env.KILN_MODEL,
    headless: options.headless,
    autoApprove: options.autoApprove,
  });

  const detected = options.dev ? `using ${options.dev}` : (await detectDevServer(options.dir))?.framework ?? 'no dev server detected';

  await app.start();
  if (options.dev) await app.setDevCommand(options.dev);

  if (options.verbose) attachVerboseStream(app);

  const daemon = createDaemon(app);
  const handle = await daemon.listen(options.port);
  const url = `http://127.0.0.1:${handle.port}`;
  app.setDaemonOrigin(url);

  const preview = app.preview();
  process.stdout.write(
    [
      '',
      `  kiln  ${options.dir}`,
      `  ui      ${url}`,
      `  preview ${preview.url ?? '(not running yet)'}`,
      `  stack   ${detected}`,
      '',
    ].join('\n'),
  );

  if (preview.url) {
    process.stdout.write(`  Preview: ${preview.url}\n`);
  } else {
    process.stdout.write(
      '  Nothing to preview yet. Describe what you want and Kiln will create it,\n' +
        '  or point it at an existing app with --dev "<command>".\n',
    );
  }

  if (!hasCredentials()) {
    process.stdout.write(
      '\n  Warning: no Anthropic credentials found. Kiln will start, but the agent\n' +
        '  cannot run until ANTHROPIC_API_KEY is set or you sign in with `claude`.\n',
    );
  }

  process.stdout.write(`\n  Open ${url}\n\n`);

  if (options.open) openBrowser(url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(`\n  kiln: ${(error as Error).message}\n\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`\n  kiln: ${reason instanceof Error ? reason.message : String(reason)}\n\n`);
  process.exit(1);
});

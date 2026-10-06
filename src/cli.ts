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
  help: boolean;
};

function parse(argv: string[]): Options {
  const options: Options = {
    dir: process.cwd(),
    port: 0,
    open: true,
    headless: false,
    autoApprove: false,
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

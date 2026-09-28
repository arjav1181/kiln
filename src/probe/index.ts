import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const TARGETS: Record<string, string> = {
  session: '01-session.ts',
  tools: '02-tools-and-permissions.ts',
  resume: '03-resume.ts',
  runtime: '04-runtime-proxy.ts',
  t0: '05-t0-inspect.ts',
  t1: '06-provenance.ts',
  e2e: '07-end-to-end.ts',
  scaffold: '08-scaffold.ts',
  image: '09-image-injection.ts',
  remote: '10-git-remote.ts',
  hitrate: '11-t0-hitrate.ts',
};

const requested = process.argv.slice(2);
const selected = requested.length
  ? requested.filter((name) => name in TARGETS)
  : Object.keys(TARGETS);

if (requested.length && selected.length !== requested.length) {
  const unknown = requested.filter((name) => !(name in TARGETS));
  console.error(`unknown probe(s): ${unknown.join(', ')}`);
  console.error(`available: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(2);
}

type Result = { name: string; ok: boolean; ms: number };

const run = (file: string): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve({ name: file.replace(/^\d+-|\.ts$/g, ''), ok: code === 0, ms: Date.now() - started }));
  });

const results: Result[] = [];
for (const name of selected) {
  console.log(`\n${'='.repeat(64)}\n${name}\n${'='.repeat(64)}`);
  results.push(await run(TARGETS[name]!));
  // Probes hold ports and browsers; give the OS a moment between them.
  await new Promise((r) => setTimeout(r, 750));
}

console.log(`\n${'='.repeat(64)}\nsummary\n${'='.repeat(64)}`);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(24)} ${(result.ms / 1000).toFixed(1)}s`);
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);

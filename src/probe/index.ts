import { spawn, type ChildProcess } from 'node:child_process';
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
  editor: '12-click-to-edit.ts',
  inject: '13-provenance-injection.ts',
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

/** Gives teardown a chance to finish before the next probe claims resources. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Probes start dev servers and browsers. Rather than trust each one to clean
 * up, the runner owns the whole process group: whatever survives a probe is
 * killed before the next one starts. Orphaned dev servers otherwise starve the
 * later probes and make them fail for reasons unrelated to what they test.
 */
function sweep(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

const run = (file: string): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit', detached: true });
    child.on('exit', (code) => {
      sweep(child);
      resolve({ name: file.replace(/^\d+-|\.ts$/g, ''), ok: code === 0, ms: Date.now() - started });
    });
  });

const results: Result[] = [];
for (const name of selected) {
  console.log(`\n${'='.repeat(64)}\n${name}\n${'='.repeat(64)}`);
  results.push(await run(TARGETS[name]!));
  // Probes hold ports, browsers and process groups. Let the OS reclaim them
  // before the next one, or late probes fail for reasons that have nothing to
  // do with what they are testing.
  await settle();
}

console.log(`\n${'='.repeat(64)}\nsummary\n${'='.repeat(64)}`);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(24)} ${(result.ms / 1000).toFixed(1)}s`);
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);

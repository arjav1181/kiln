import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type DependencyPlan = {
  command: string;
  args: string[];
  manager: string;
  /** What we compare against mtime to decide whether to re-run. */
  manifest: string;
};

/**
 * Works out how to install this project's dependencies, if it has any.
 * Returns null for stacks where the run step is self-sufficient, or where we
 * would rather let the agent deal with it.
 */
export function planInstall(dir: string): DependencyPlan | null {
  const has = (...files: string[]) => files.some((file) => existsSync(join(dir, file)));

  if (has('package.json')) {
    const lock = has('bun.lock', 'bun.lockb')
      ? 'bun'
      : has('pnpm-lock.yaml')
        ? 'pnpm'
        : has('yarn.lock')
          ? 'yarn'
          : 'npm';
    return { command: lock, args: ['install'], manager: lock, manifest: 'package.json' };
  }

  if (has('go.mod')) {
    return { command: 'go', args: ['mod', 'download'], manager: 'go', manifest: 'go.mod' };
  }

  if (has('requirements.txt')) {
    return { command: 'python3', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], manager: 'pip', manifest: 'requirements.txt' };
  }

  if (has('pyproject.toml')) {
    return { command: 'python3', args: ['-m', 'pip', 'install', '-e', '.'], manager: 'pip', manifest: 'pyproject.toml' };
  }

  if (has('Gemfile')) {
    return { command: 'bundle', args: ['install'], manager: 'bundler', manifest: 'Gemfile' };
  }

  if (has('mix.exs')) {
    return { command: 'mix', args: ['deps.get'], manager: 'mix', manifest: 'mix.exs' };
  }

  return null;
}

/** True when the dependency tree is missing or older than the manifest. */
export function needsInstall(dir: string, plan: DependencyPlan): boolean {
  if (plan.manager === 'npm' || plan.manager === 'pnpm' || plan.manager === 'yarn' || plan.manager === 'bun') {
    return !existsSync(join(dir, 'node_modules'));
  }
  if (plan.manager === 'go') {
    return !existsSync(join(dir, 'go.sum')) && !existsSync(join(dir, 'vendor'));
  }
  // Virtualenvs and bundle paths are environment-specific, so only install when
  // the project ships a lock file and nothing has been vendored.
  return !existsSync(join(dir, '.venv')) && !existsSync(join(dir, 'vendor'));
}

export type InstallResult = {
  ok: boolean;
  output: string;
  manager: string;
};

export function runInstall(
  dir: string,
  plan: DependencyPlan,
  onLog: (line: string) => void,
  timeoutMs = 10 * 60_000,
): Promise<InstallResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const child = spawn(plan.command, plan.args, {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const record = (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\n')) {
        const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
        if (!text) continue;
        lines.push(text);
        onLog(text);
        if (lines.length > 400) lines.shift();
      }
    };

    child.stdout?.on('data', record);
    child.stderr?.on('data', record);

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      resolve({ ok: false, output: lines.join('\n'), manager: plan.manager });
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${lines.join('\n')}\n${error.message}`.trim(), manager: plan.manager });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: lines.join('\n'), manager: plan.manager });
    });
  });
}

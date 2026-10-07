import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);

export type Checkpoint = {
  id: string;
  promptUuid: string;
  parent: string | null;
  at: string;
  message: string;
  files: string[];
  costUsd: number;
};

const BRANCH = 'kiln';
const TRAILER = 'kiln-prompt';

export class GitError extends Error {
  readonly output: string;
  /** Whether this is a problem with the environment rather than the command. */
  readonly fatal: boolean;

  constructor(command: string, output: string, code?: string) {
    super(explain(command, output, code));
    this.output = output;
    this.fatal = isEnvironmentProblem(output, code);
  }
}

const KNOWN: Array<{ test: RegExp; message: string; fatal: boolean }> = [
  {
    test: /Author identity unknown|Please tell me who you are/i,
    message:
      'git has no user configured for this repository. Kiln sets a local identity ' +
      'automatically, so this usually means the project directory is not writable.',
    fatal: true,
  },
  {
    test: /dubious ownership/i,
    message:
      "git does not trust this repository's owner. Run:\n" +
      '  git config --global --add safe.directory <your-project-path>',
    fatal: true,
  },
  {
    test: /index\.lock: File exists|Unable to create .*index\.lock/i,
    message:
      'Another git process is using this repository. If nothing is running, a ' +
      'previous one was interrupted; remove the stale lock file:\n' +
      '  rm <project>/.git/index.lock',
    fatal: false,
  },
  {
    test: /does not appear to be a git repository/i,
    message: 'That directory is inside a git repository Kiln cannot use.',
    fatal: true,
  },
];

function explain(command: string, output: string, code?: string): string {
  if (code === 'ENOENT') return 'git is not installed, or is not on your PATH.';

  const known = KNOWN.find((entry) => entry.test.test(output));
  if (known) return known.message;

  const first = output.split('\n').find((line) => line.trim().length > 0) ?? '';
  return first ? `git ${command} failed: ${first.trim()}` : `git ${command} failed`;
}

function isEnvironmentProblem(output: string, code?: string): boolean {
  if (code === 'ENOENT') return true;
  return KNOWN.some((entry) => entry.fatal && entry.test.test(output));
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    const code = (error as { code?: string }).code;
    throw new GitError(args.join(' '), output, code);
  }
}

/**
 * One commit per turn on a dedicated branch, with the SDK prompt uuid in the
 * message. Git is the whole history model: the timeline reads the log, restore
 * is a reset, and the user can `git checkout` out of Kiln at any moment.
 */
export class History {
  #ready = false;
  readonly dir: string;
  readonly branch: string;

  constructor(dir: string, branch = BRANCH) {
    this.dir = dir;
    this.branch = branch;
  }

  async init(): Promise<void> {
    if (this.#ready) return;

    // Kiln gives each project its own repository. Adopting whatever repo
    // happens to sit above the directory is surprising: it would commit the app
    // into someone else's history, and that repo's .gitignore would then decide
    // what Kiln is allowed to track.
    const root = (await git(['rev-parse', '--show-toplevel'], this.dir).catch(() => '')).trim();
    const isRepoRoot = root !== '' && resolve(root) === resolve(this.dir);

    if (!isRepoRoot) {
      await git(['init', '-q'], this.dir);
    }

    await this.ensureIdentity();

    // `rev-parse HEAD` fails on an unborn branch, which is every fresh project.
    const current = (await git(['symbolic-ref', '--short', 'HEAD'], this.dir).catch(() => '')).trim();
    if (current === this.branch) {
      this.#ready = true;
      return;
    }

    const exists = await git(['rev-parse', '--verify', this.branch], this.dir)
      .then(() => true)
      .catch(() => false);

    if (exists) await git(['checkout', '-q', this.branch], this.dir);
    else await git(['checkout', '-q', '-b', this.branch], this.dir);
    this.#ready = true;
  }

  /** Fresh projects have no git identity, and commits would fail without one. */
  async ensureIdentity(): Promise<void> {
    await git(['config', 'user.email', 'kiln@localhost'], this.dir);
    await git(['config', 'user.name', 'Kiln'], this.dir);
  }

  async isDirty(): Promise<boolean> {
    return (await git(['status', '--porcelain'], this.dir)).trim().length > 0;
  }

  async changedFiles(): Promise<string[]> {
    const out = await git(['status', '--porcelain'], this.dir);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((path) => !path.includes(' -> '))
      .map((path) => path.split(' -> ').pop()!);
  }

  async commit(input: {
    promptUuid: string;
    message: string;
    costUsd: number;
  }): Promise<Checkpoint | null> {
    await this.init();
    await this.ensureIdentity();

    const before = (await git(['rev-parse', 'HEAD'], this.dir).catch(() => '')).trim();
    // No pathspec: `git add -A -- .` hard-fails when the pathspec resolves to a
    // gitignored path, which a project inheriting a parent's .gitignore will.
    await git(['config', 'advice.addIgnoredFile', 'false'], this.dir).catch(() => {});
    await git(['add', '-A'], this.dir);
    if (!(await this.isDirty())) return null;

    const changed = await this.changedFiles();
    const body = [
      input.message.trim().split('\n')[0]?.slice(0, 200) || 'turn',
      '',
      `${TRAILER}: ${input.promptUuid}`,
      `kiln-cost: ${input.costUsd.toFixed(6)}`,
      '',
    ].join('\n');

    await git(['commit', '-q', '-m', body], this.dir);

    const head = (await git(['rev-parse', 'HEAD'], this.dir)).trim();
    return {
      id: head,
      promptUuid: input.promptUuid,
      parent: before || null,
      at: new Date().toISOString(),
      message: input.message,
      files: changed,
      costUsd: input.costUsd,
    };
  }

  async log(limit = 100): Promise<Checkpoint[]> {
    await this.init();
    const format = ['%H', '%P', '%aI', '%s', `%${TRAILER}`, 'kiln-cost'].join('%x1f');
    let out: string;
    try {
      out = await git(['log', `-${limit}`, `--format=${format}`, this.branch], this.dir);
    } catch {
      return [];
    }

    return out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [id, parents, at, subject, promptUuid = '', cost = '0'] = line.split('\x1f');
        return {
          id: id ?? '',
          promptUuid,
          parent: parents?.split(' ')[0] || null,
          at: at ?? '',
          message: subject ?? '',
          files: [],
          costUsd: Number(cost) || 0,
        };
      })
      .reverse();
  }

  /** Restores the working tree to a checkpoint. Conversation rollback is the SDK's job. */
  async restore(id: string): Promise<void> {
    await this.init();
    await git(['reset', '--hard', id], this.dir);
  }

  async remote(): Promise<string | null> {
    const out = await git(['remote', 'get-url', 'origin'], this.dir).catch(() => '');
    return out.trim() || null;
  }
}

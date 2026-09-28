import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './history.ts';

const exec = promisify(execFile);

export type RemoteStatus = {
  configured: boolean;
  url: string | null;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasGh: boolean;
  ghAuthed: boolean;
  repo: string | null;
  lastError: string | null;
};

export type PushResult = {
  pushed: boolean;
  branch: string;
  url: string;
  detail: string;
};

async function hasCommand(command: string, args: string[]): Promise<boolean> {
  try {
    await exec(command, args, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Publishes the Kiln branch to a git remote.
 *
 * The working branch is `kiln`, deliberately not `main`: the user's history is
 * never rewritten by an agent turn, and a pull request is the reviewable
 * boundary between what the agent did and what the user merged.
 */
export class Remote {
  readonly dir: string;
  readonly branch: string;

  constructor(dir: string, branch = 'kiln') {
    this.dir = dir;
    this.branch = branch;
  }

  async status(): Promise<RemoteStatus> {
    const url = (await git(['remote', 'get-url', 'origin'], this.dir).catch(() => '')).trim() || null;
    const upstream = (
      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], this.dir).catch(() => '')
    ).trim() || null;

    const count = async (range: string) => {
      const out = await git(['rev-list', '--count', range], this.dir).catch(() => '0');
      return Number(out.trim()) || 0;
    };

    const hasGh = await hasCommand('gh', ['--version']);
    const ghAuthed = hasGh && (await hasCommand('gh', ['auth', 'status']));
    const repo = ghAuthed ? ((await git(['config', '--get', 'remote.origin.url'], this.dir).catch(() => '')).trim() || null) : null;

    return {
      configured: Boolean(url),
      url,
      branch: this.branch,
      upstream,
      ahead: upstream ? await count(`${upstream}..${this.branch}`) : 0,
      behind: upstream ? await count(`${this.branch}..${upstream}`) : 0,
      hasGh,
      ghAuthed,
      repo,
      lastError: null,
    };
  }

  async connect(url: string): Promise<RemoteStatus> {
    const existing = (await git(['remote', 'get-url', 'origin'], this.dir).catch(() => '')).trim();
    if (existing) await git(['remote', 'set-url', 'origin', url], this.dir);
    else await git(['remote', 'add', 'origin', url], this.dir);
    return this.status();
  }

  async disconnect(): Promise<void> {
    await git(['remote', 'remove', 'origin'], this.dir).catch(() => {});
  }

  async push(): Promise<PushResult> {
    const status = await this.status();
    if (!status.url) throw new Error('No remote configured. Connect a repository first.');

    // An HTTPS remote without credentials fails here; surface that plainly
    // rather than as a git stack trace.
    const out = await git(['push', '--set-upstream', 'origin', this.branch], this.dir);
    const line = out.split('\n').find((l) => /->/.test(l)) ?? '';
    const detail = line.trim().replace(/.*->\s*/, '') || status.url;
    return { pushed: true, branch: this.branch, url: detail, detail: out.trim() };
  }

  async fetch(): Promise<void> {
    await git(['fetch', 'origin'], this.dir);
  }

  /**
   * Opens a pull request for the Kiln branch. Requires the GitHub CLI, since
   * that is what the user already has authenticated.
   */
  async createPullRequest(input: { title: string; body: string; base?: string }): Promise<{ url: string; number: number | null }> {
    const status = await this.status();
    if (!status.url) throw new Error('No remote configured.');

    const args = [
      'pr', 'create',
      '--title', input.title,
      '--body', input.body,
      '--head', this.branch,
    ];
    if (input.base) args.push('--base', input.base);

    const { stdout } = await exec('gh', args, { cwd: this.dir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const url = stdout.trim().split('\n').pop()?.trim() ?? '';
    const match = /\/pull\/(\d+)/.exec(url);
    return { url, number: match ? Number(match[1]) : null };
  }
}

/**
 * Assembles a reviewable summary of what the agent did since a point, which is
 * what a pull request body should actually say.
 */
export async function summariseBranch(dir: string, base: string, head: string): Promise<{ title: string; body: string }> {
  const log = await git(['log', '--oneline', `${base}..${head}`], dir).catch(() => '');
  const commits = log.split('\n').filter(Boolean);

  const stat = await git(['diff', '--stat', `${base}..${head}`], dir).catch(() => '');
  const files = stat
    .split('\n')
    .filter((l) => /\|\s+\d+/.test(l))
    .map((l) => l.split('|')[0]!.trim())
    .filter(Boolean);

  const summary = stat.split('\n').filter(Boolean).pop() ?? '';

  return {
    title: commits[0]?.replace(/^[0-9a-f]+\s+/, '') ?? `Changes from ${head}`,
    body: [
      '## What the agent did',
      '',
      ...(commits.length ? commits.map((c) => `- ${c.replace(/^[0-9a-f]+\s+/, '')}`) : ['- (no commits)']),
      '',
      '## Files changed',
      '',
      ...(files.length ? files.map((f) => `- \`${f}\``) : ['- (none)']),
      '',
      `\`\`\`\n${summary}\n\`\`\``,
      '',
      '_Opened by [kiln](https://www.npmjs.com/package/kiln)._',
    ].join('\n'),
  };
}

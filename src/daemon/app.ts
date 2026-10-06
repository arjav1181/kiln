import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Session, type PermissionRequest } from '../sdk/session.ts';
import { createKilnServer, type ConsoleReport, type ElementReport, type KilnDeps, type PreviewState } from '../sdk/tools.ts';
import type { KilnEvent, PermissionDecision } from '../sdk/events.ts';
import { git, History, type Checkpoint } from '../project/history.ts';
import { Remote, summariseBranch, type RemoteStatus } from '../project/remote.ts';
import { detectPublish, writeDockerfile, type PublishTarget } from '../runtime/publish.ts';
import { startDevServer, type DevServer } from '../runtime/manager.ts';
import { needsInstall, planInstall, runInstall } from '../runtime/deps.ts';
import { createProxy } from '../proxy/server.ts';
import { launchBrowser, type Browser, type ConsoleEntry } from '../capture/browser.ts';
import { inspectElement } from '../capture/element.ts';
import { InjectionPolicy, touchesUi } from '../injection/policy.ts';
import { buildIndex, describeEdit, lookup, snippetFor, type ResolvedElement } from '../provenance/resolve.ts';
import { PendingRegistry } from './requests.ts';

/**
 * A turn that ends without calling a single tool, while the reply contains a
 * tool-call marker, is a malformed turn: the model tried to act and the stream
 * delivered the call as text.
 */
const TOOL_MARKER = /<[｜|]?.*?(?:tool_call|tool_use|invoke\s+name=|function call)|[｜|]{2}DSML[｜|]{2}/i;

type TurnProgress = { text: string; tools: number };

export type AppOptions = {
  dir: string;
  model?: string;
  /** Skip the browser; useful in headless environments and for tests. */
  headless?: boolean;
  autoApprove?: boolean;
  /** Automatic retry for a turn that tried to act but called no tools. */
  recoverMalformedTurns?: boolean;
};

export type Outstanding =
  | { kind: 'permission'; requestId: string; toolName: string; input: unknown; title: string; description: string; canRemember: boolean }
  | { kind: 'question'; requestId: string; question: string; choices: string[] };

export type AppState = {
  dir: string;
  preview: PreviewState;
  sessionId: string | null;
  checkpoints: Checkpoint[];
  costUsd: number;
  busy: boolean;
  lastError: string | null;
  /** Prompts still waiting on the user, so a reconnecting UI can show them. */
  outstanding: Outstanding[];
};

type TurnRecord = {
  promptUuid: string;
  message: string;
  files: string[];
  screenshot?: string;
};

/**
 * Owns one project's agent session, dev server, preview proxy and history, and
 * turns a user prompt into a checkpointed turn.
 */
export class App {
  readonly dir: string;
  readonly history: History;
  readonly remote: Remote;
  readonly policy = new InjectionPolicy();
  #options: AppOptions;

  #session: Session | null = null;
  #server: DevServer | null = null;
  #proxy: ReturnType<typeof createProxy> | null = null;
  #proxyPort = 0;
  #proxyClient = { origin: '' };
  #browser: Browser | null = null;
  #provenance: Awaited<ReturnType<typeof buildIndex>> | null = null;
  #listeners = new Set<(event: KilnEvent | AppNotice) => void>();

  #permissions = new PendingRegistry<PermissionDecision>();
  #outstanding = new Map<string, Outstanding>();
  #questions = new PendingRegistry<string>();
  #turns: TurnRecord[] = [];
  #busy = false;
  #reconciling = false;
  #turn: TurnProgress = { text: '', tools: 0 };
  #retries = 0;
  #unhookExit: (() => void) | null = null;
  #cost = 0;
  #lastError: string | null = null;
  #console: ConsoleEntry[] = [];
  #errorsSeen = 0;

  constructor(options: AppOptions) {
    this.#options = options;
    this.dir = options.dir;
    this.history = new History(options.dir);
    this.remote = new Remote(options.dir, this.history.branch);
  }

  get previewUrl(): string {
    return this.#proxyPort ? `http://127.0.0.1:${this.#proxyPort}/` : '';
  }

  get proxy(): ReturnType<typeof createProxy> | null {
    return this.#proxy;
  }

  get browser(): Browser | null {
    return this.#browser;
  }

  get turns(): readonly TurnRecord[] {
    return this.#turns;
  }

  async state(): Promise<AppState> {
    return {
      dir: this.dir,
      preview: this.preview(),
      sessionId: this.#session?.sessionId ?? null,
      checkpoints: await this.history.log(),
      costUsd: this.#cost,
      busy: this.#busy,
      lastError: this.#lastError,
      outstanding: [...this.#outstanding.values()],
    };
  }

  preview(): PreviewState {
    return {
      running: this.#server !== null,
      url: this.#proxyPort ? `http://127.0.0.1:${this.#proxyPort}/` : null,
      framework: this.#server?.framework ?? null,
    };
  }

  subscribe(listener: (event: KilnEvent | AppNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: KilnEvent | AppNotice): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take down the turn.
      }
    }
  }

  // ---- lifecycle -------------------------------------------------------

  async start(): Promise<void> {
    if (!existsSync(this.dir)) throw new Error(`No such directory: ${this.dir}`);
    await this.history.init();
    await this.checkpointScaffold();

    const target = await this.#startPreview();
    if (target) {
      this.#proxy = createProxy({
        host: '127.0.0.1',
        port: target.port,
        client: this.#proxyClient,
      });
      this.#proxyPort = await this.#proxy.listen(0);
      this.#emit({ kind: 'preview', url: this.previewUrl, framework: target.framework });
    }

    if (!this.#options.headless) {
      try {
        this.#browser = await launchBrowser();
        this.#browser.enableConsole((entry) => this.#recordConsole(entry));
        if (this.#proxyPort) await this.#browser.goto(this.previewUrl);
      } catch (error) {
        this.#lastError = `browser unavailable: ${(error as Error).message}`;
        this.#browser = null;
      }
    }

    await this.refreshProvenance();
    this.#hookExit();
    this.#emit({ kind: 'ready', dir: this.dir, preview: this.preview() });
  }

  /**
   * A dev server that outlives the daemon keeps its port, which then blocks the
   * next run. There is no way to run async teardown from a signal handler, so
   * the process is torn down synchronously instead.
   */
  #hookExit(): void {
    if (this.#unhookExit) return;
    const bail = () => {
      try {
        this.#server?.stop();
      } catch {
        // Best effort; the process is going away.
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const) {
      process.once(signal, bail);
    }
    this.#unhookExit = () => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const) {
        process.removeListener(signal, bail);
      }
    };
  }

  /**
   * Re-derives element ids from disk. Cheap, and it means a selection still
   * resolves when no dev server is running.
   */
  async refreshProvenance(): Promise<number> {
    this.#provenance = await buildIndex(this.dir);
    return this.#provenance.byId.size;
  }

  /**
   * Resolves a click to source. With transform-time ids available this is exact;
   * without them the caller still gets the T0 element report and the agent
   * locates the file itself.
   */
  async resolveSelection(input: { selector: string; kilnId: string | null }) {
    // The DOM report is a nicety; an indexed id is the valuable part, so it
    // resolves on its own even with no browser attached.
    const indexed = input.kilnId && this.#provenance ? lookup(this.#provenance, input.kilnId) : null;
    if (!indexed) {
      return { report: await this.#inspect(input.selector), exact: null };
    }

    const resolved: ResolvedElement = {
      id: indexed.id,
      tag: indexed.tag,
      attributes: indexed.attributes,
      // Project-relative: the agent should be told where in its own project the
      // element lives, not where it happens to sit on this machine.
      file: relative(this.dir, indexed.file),
      line: indexed.line,
      column: indexed.column,
      snippet: await snippetFor(indexed.file, indexed.line),
    };
    return { report: await this.#inspect(input.selector), exact: resolved };
  }

  /** Turns a resolved selection plus an intent into an unambiguous instruction. */
  async buildEditInstruction(input: { selector: string; kilnId: string | null; intent: string }): Promise<string | null> {
    const { exact } = await this.resolveSelection(input);
    if (!exact) return null;
    return describeEdit(exact, input.intent);
  }

  /**
   * Commits whatever already exists before the first turn, so the history reads
   * as "scaffold", then one entry per turn, instead of folding the whole project
   * into the first real change.
   */
  /**
   * Brings the preview up once the project is servable.
   *
   * This is what makes an empty directory work: the first turn scaffolds the
   * project, and the preview appears as soon as there is something to serve.
   * An already-running server is left alone, because restarting it would throw
   * away the agent's HMR state mid-turn.
   */
  async reconcilePreview(): Promise<boolean> {
    if (this.#server) return true;
    if (this.#reconciling) return false;

    this.#reconciling = true;
    try {
      await this.#installDependencies();
      const started = await this.#startPreview();
      if (!started) return false;
      await this.#rewireProxy();
      if (this.#browser && this.#proxyPort) await this.#browser.goto(this.previewUrl);
      this.#emit({ kind: 'preview', url: this.previewUrl, framework: started.framework });
      return true;
    } finally {
      this.#reconciling = false;
    }
  }

  /**
   * A scaffolded project has no dependencies installed, and nobody should have
   * to know that. Install before serving, and tell the agent what happened.
   */
  async #installDependencies(): Promise<void> {
    const plan = planInstall(this.dir);
    if (!plan || !needsInstall(this.dir, plan)) return;

    this.#emit({ kind: 'deps.starting', manager: plan.manager });
    const result = await runInstall(this.dir, plan, (line) =>
      this.#emit({ kind: 'server.log', line }),
    );
    this.#emit({
      kind: 'deps.done',
      manager: plan.manager,
      ok: result.ok,
      detail: result.ok ? '' : result.output.split('\n').slice(-5).join(' | '),
    });
    if (!result.ok) this.#lastError = `Installing ${plan.manager} dependencies failed`;
  }

  async checkpointScaffold(): Promise<void> {
    if (!(await this.history.isDirty())) return;
    await this.history.commit({ promptUuid: 'scaffold', message: 'Project scaffold', costUsd: 0 });
  }

  async #startPreview(): Promise<DevServer | null> {
    try {
      const server = await startDevServer({
        cwd: this.dir,
        onLog: (line) => this.#emit({ kind: 'server.log', line }),
      });
      this.#server = server;
      return server;
    } catch (error) {
      // An unrecognised stack is not fatal: the user can type a dev command.
      this.#lastError = (error as Error).message;
      this.#server = null;
      return null;
    }
  }

  async setDevCommand(command: string): Promise<boolean> {
    this.#server?.stop();
    const [bin, ...args] = command.trim().split(/\s+/);
    this.#server = await startDevServer({
      cwd: this.dir,
      target: { command: bin!, args },
      onLog: (line) => this.#emit({ kind: 'server.log', line }),
    });
    await this.#rewireProxy();
    if (this.#browser && this.#proxyPort) await this.#browser.goto(this.previewUrl);
    this.#emit({ kind: 'preview', url: this.previewUrl, framework: this.#server.framework });
    return true;
  }

  /** Published once the daemon is listening, so the injected client can call back. */
  setDaemonOrigin(origin: string): void {
    this.#proxyClient.origin = origin;
  }

  noteError(level: string, text: string): void {
    this.#recordConsole({ level, text });
    this.#emit({ kind: 'preview.log', level, text });
  }

  async #rewireProxy(): Promise<void> {
    await this.#proxy?.close();
    if (!this.#server) return;
    this.#proxy = createProxy({
      host: '127.0.0.1',
      port: this.#server.port,
      client: this.#proxyClient,
    });
    this.#proxyPort = await this.#proxy.listen(0);
  }

  async stop(): Promise<void> {
    this.#unhookExit?.();
    this.#outstanding.clear();
    this.#permissions.clear();
    this.#questions.clear();
    await this.#session?.close().catch(() => {});
    await this.#proxy?.close();
    this.#server?.stop();
    await this.#browser?.close();
  }

  // ---- publishing ------------------------------------------------------

  async remoteStatus(): Promise<RemoteStatus> {
    return this.remote.status();
  }

  async connectRemote(url: string): Promise<RemoteStatus> {
    return this.remote.connect(url);
  }

  async push(): Promise<unknown> {
    return this.remote.push();
  }

  /**
   * Pushes the branch and opens a reviewable pull request. The base defaults to
   * the project's main branch, so an agent's work never lands unreviewed.
   */
  async openPullRequest(title?: string, body?: string): Promise<{ url: string; number: number | null }> {
    const status = await this.remote.status();
    if (!status.url) throw new Error('Connect a repository before opening a pull request.');

    const base = await this.#defaultBase();
    const summary = await summariseBranch(this.dir, base, this.history.branch);
    return this.remote.createPullRequest({
      title: title?.trim() || summary.title,
      body: body?.trim() || summary.body,
      base,
    });
  }

  async #defaultBase(): Promise<string> {
    const branches = (await git(['branch', '-r', '--format=%(refname:short)'], this.dir).catch(() => ''))
      .split('\n')
      .map((line) => line.trim().replace(/^origin\//, ''))
      .filter(Boolean);
    return branches.find((name) => /^(main|master)$/.test(name)) ?? 'main';
  }

  async publishTarget(): Promise<PublishTarget> {
    return detectPublish(this.dir);
  }

  async writePublishScaffold(): Promise<{ path: string; target: PublishTarget }> {
    const target = await detectPublish(this.dir);
    if (!target.dockerfile) {
      throw new Error(`${target.label}: ${target.detail}`);
    }
    const path = await writeDockerfile(this.dir, target.dockerfile);
    return { path, target };
  }

  // ---- agent -----------------------------------------------------------

  #ensureSession(): Session {
    if (this.#session) return this.#session;
    this.#session = this.#openSession();
    return this.#session;
  }

  #openSession(): Session {
    const session = Session.open({
      cwd: this.dir,
      model: this.#options.model,
      includePartialMessages: true,
      mcpServers: { kiln: createKilnServer(this.#kilnDeps()) },
      onPermission: (request) => this.#askPermission(request),
    });
    void this.#pump(session);
    return session;
  }

  async prompt(text: string): Promise<{ promptUuid: string }> {
    if (this.#busy) throw new Error('A turn is already running');
    this.#busy = true;
    this.#retries = 0;
    this.#lastError = null;
    this.#emit({ kind: 'busy', busy: true });

    const session = this.#ensureSession();
    const promptUuid = await session.send(text);
    this.#turns.push({ promptUuid, message: text, files: [] });
    return { promptUuid };
  }

  interrupt(): Promise<unknown> {
    return this.#session?.interrupt() ?? Promise.resolve();
  }

  answerPermission(requestId: string, decision: PermissionDecision): boolean {
    return this.#permissions.settle(requestId, decision);
  }

  answerQuestion(requestId: string, answer: string): boolean {
    return this.#questions.settle(requestId, answer);
  }

  async restore(checkpointId: string): Promise<void> {
    const checkpoints = await this.history.log();
    const target = checkpoints.find((c) => c.id === checkpointId);
    if (!target) throw new Error(`Unknown checkpoint ${checkpointId}`);

    await this.history.restore(checkpointId);
    if (target.promptUuid && this.#session) {
      // The SDK forks the conversation; git restores the files.
      this.#session = Session.open({
        cwd: this.dir,
        model: this.#options.model,
        includePartialMessages: true,
        resume: this.#session.sessionId,
        resumeSessionAt: target.promptUuid,
        mcpServers: { kiln: createKilnServer(this.#kilnDeps()) },
        onPermission: (request) => this.#askPermission(request),
      });
      void this.#pump(this.#session);
    }
    this.policy.reset();
    this.#emit({ kind: 'restored', checkpointId });
  }

  async #pump(session: Session): Promise<void> {
    for await (const event of session.events) {
      this.#emit(event);
      if (event.kind === 'text') this.#turn.text += event.delta;
      if (event.kind === 'tool.start') this.#turn.tools += 1;
      if (event.kind === 'turn.start') this.#turn = { text: '', tools: 0 };

      if (event.kind === 'turn.end') {
        if (await this.#recoverMalformedTurn(session, event)) continue;
        this.#busy = false;
        this.#cost = event.costUsd;
        await this.#finishTurn(event.promptUuid, event.costUsd, event.isError, event.stopReason ?? '');
      } else if (event.kind === 'fatal') {
        this.#busy = false;
        this.#lastError = event.message;
        this.#emit({ kind: 'busy', busy: false });
      }
    }
  }

  /**
   * Retries a turn that ended without acting. Deliberately narrow: only when
   * the turn produced no tool calls at all *and* the reply carries a tool-call
   * marker, and only once per user prompt, so a genuinely tool-free turn is
   * never nudged into doing something the user did not ask for.
   */
  async #recoverMalformedTurn(
    session: Session,
    event: Extract<KilnEvent, { kind: 'turn.end' }>,
  ): Promise<boolean> {
    const recovery = this.#options.recoverMalformedTurns ?? true;
    if (!recovery || this.#retries >= 1) return false;
    if (this.#turn.tools > 0) return false;
    if (event.stopReason !== 'end_turn' || event.isError) return false;
    if (!TOOL_MARKER.test(this.#turn.text)) return false;

    this.#retries += 1;
    this.#emit({
      kind: 'turn.retrying',
      reason: 'the turn ended without running a tool',
      attempt: this.#retries + 1,
    });
    await session.send(
      'Your last message was cut off before you acted. Do not describe what you are ' +
        'about to do — make the change now, then report the result.',
    );
    return true;
  }

  async #finishTurn(
    promptUuid: string,
    costUsd: number,
    isError: boolean,
    stopReason: string,
  ): Promise<void> {
    const record = this.#turns.find((t) => t.promptUuid === promptUuid);
    const message = record?.message ?? '';

    // The first turn may have turned an empty directory into a servable
    // project, so the preview gets a chance to come up before we capture.
    await this.reconcilePreview();
    await this.refreshProvenance().catch(() => {});

    const checkpoint = await this.history.commit({ promptUuid, message, costUsd });
    if (checkpoint && record) {
      record.files = checkpoint.files;
      record.screenshot = await this.#maybeCapture(promptUuid, checkpoint.files, isError);
    }

    this.#emit({
      kind: 'turn.done',
      promptUuid,
      checkpointId: checkpoint?.id ?? null,
      files: checkpoint?.files ?? [],
      costUsd,
      isError,
      stopReason,
    });
    this.#emit({ kind: 'busy', busy: false });
  }

  /** Applies the injection policy and captures only when it is worth the tokens. */
  async #maybeCapture(promptUuid: string, files: string[], isError: boolean): Promise<string | undefined> {
    if (!this.#browser || !this.#proxyPort) return undefined;

    const decision = this.policy.decide({
      requested: false,
      forced: false,
      files,
      newErrors: this.#errorsSeen,
      failed: isError,
    });
    this.#errorsSeen = 0;

    const shot = await this.#capture().catch(() => null);
    if (!shot) return undefined;

    const record = this.policy.record(shot.base64);
    if (!decision.inject || !record.inject) {
      this.#emit({ kind: 'preview.skipped', reason: decision.inject ? record.reason : decision.reason });
      return undefined;
    }

    const dir = join(this.dir, '.kiln', 'artifacts');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${promptUuid}.png`);
    await writeFile(file, Buffer.from(shot.base64, 'base64'));
    this.#emit({ kind: 'preview.captured', path: file, reason: decision.reason });
    return file;
  }

  #kilnDeps(): KilnDeps {
    return {
      preview: () => this.preview(),
      captureScreenshot: () => this.#capture(),
      readConsole: () => this.#readConsole(),
      inspectElement: (selector) => this.#inspect(selector),
      askUser: (question, choices) => this.#askUser(question, choices),
    };
  }

  async #capture(): Promise<{ base64: string; mimeType: string }> {
    if (!this.#browser) throw new Error('no browser');
    const data = await this.#browser.screenshot();
    return { base64: data, mimeType: 'image/png' };
  }

  async #readConsole(): Promise<ConsoleReport> {
    const entries = this.#console;
    return {
      errors: entries
        .filter((e) => e.level === 'error')
        .map((e) => ({ level: e.level, text: e.text, source: e.url })),
      networkFailures: [],
      pageErrors: entries.filter((e) => e.level === 'pageerror').map((e) => e.text),
    };
  }

  #recordConsole(entry: ConsoleEntry): void {
    this.#console.push(entry);
    if (this.#console.length > 200) this.#console.splice(0, this.#console.length - 200);
    if (entry.level === 'error' || entry.level === 'pageerror') this.#errorsSeen += 1;
  }

  async #inspect(selector: string): Promise<ElementReport | null> {
    if (!this.#browser) return null;
    return inspectElement(this.#browser, selector);
  }

  async #askUser(question: string, choices: string[]): Promise<string> {
    const id = randomUUID();
    this.#outstanding.set(id, { kind: 'question', requestId: id, question, choices });
    this.#emit({ kind: 'question', requestId: id, question, choices });
    const answer = await this.#questions.wait(id);
    this.#outstanding.delete(id);
    return answer ?? '(no answer)';
  }

  async #askPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.#options.autoApprove || request.toolName.startsWith('mcp__kiln__')) {
      return Promise.resolve({ allow: true, remember: false });
    }
    const payload: Outstanding = {
      kind: 'permission',
      requestId: request.requestId,
      toolName: request.toolName,
      input: request.input,
      title: request.title ?? request.toolName,
      description: request.description ?? '',
      canRemember: request.canRemember,
    };
    this.#outstanding.set(request.requestId, payload);
    this.#emit(payload);
    const decision = await this.#permissions.wait(request.requestId);
    this.#outstanding.delete(request.requestId);
    // Nobody answered: say so rather than leaving the turn hanging.
    return decision ?? { allow: false, reason: 'No one answered this permission request, so it was denied.' };
  }
}

export type AppNotice =
  | { kind: 'ready'; dir: string; preview: PreviewState }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'preview'; url: string; framework: string | null }
  | { kind: 'preview.captured'; path: string; reason: string }
  | { kind: 'preview.skipped'; reason: string }
  | { kind: 'preview.log'; level: string; text: string }
  | { kind: 'deps.starting'; manager: string }
  | { kind: 'deps.done'; manager: string; ok: boolean; detail: string }
  | { kind: 'server.log'; line: string }
  | { kind: 'turn.done'; promptUuid: string; checkpointId: string | null; files: string[]; costUsd: number; isError: boolean; stopReason: string }
  | { kind: 'turn.retrying'; reason: string; attempt: number }
  | { kind: 'restored'; checkpointId: string }
  | { kind: 'question'; requestId: string; question: string; choices: string[] }
  | { kind: 'permission'; requestId: string; toolName: string; input: unknown; title: string; description: string; canRemember: boolean };

export { touchesUi };

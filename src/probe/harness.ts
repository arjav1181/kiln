import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, type SessionConfig } from '../sdk/session.ts';
import { createKilnServer, type KilnDeps } from '../sdk/tools.ts';

export type TurnSummary = {
  promptUuid: string;
  result: string;
  isError: boolean;
  costUsd: number;
  tools: string[];
  text: string;
};

export type ProbeOptions = {
  session?: Partial<SessionConfig>;
  tools?: KilnDeps;
};

/**
 * Drives a session and resolves one TurnSummary per completed turn.
 *
 * The SDK keeps the query generator open across turns in streaming-input mode,
 * so a consumer must outlive any single turn rather than iterating to
 * completion.
 */
export class Probe {
  #turn: { text: string; tools: string[] } = { text: '', tools: [] };
  #waiters: ((turn: TurnSummary) => void)[] = [];
  #spent = 0;
  readonly session: Session;

  constructor(session: Session) {
    this.session = session;
    void this.#consume();
  }

  get costUsd(): number {
    return this.#spent;
  }

  async #consume(): Promise<void> {
    for await (const event of this.session.events) {
      if (event.kind === 'text') {
        this.#turn.text += event.delta;
      } else if (event.kind === 'tool.start') {
        this.#turn.tools.push(event.name);
      } else if (event.kind === 'turn.end' || event.kind === 'fatal') {
        const turn: TurnSummary =
          event.kind === 'fatal'
            ? {
                promptUuid: '',
                result: `FATAL: ${event.message}`,
                isError: true,
                costUsd: 0,
                tools: this.#turn.tools,
                text: this.#turn.text,
              }
            : {
                promptUuid: event.promptUuid,
                result: event.result,
                isError: event.isError,
                costUsd: event.costUsd,
                tools: this.#turn.tools,
                text: this.#turn.text,
              };
        this.#turn = { text: '', tools: [] };
        this.#spent += turn.costUsd;
        this.#waiters.shift()?.(turn);
      }
    }
  }

  async send(prompt: string): Promise<TurnSummary> {
    const completed = new Promise<TurnSummary>((resolve) => this.#waiters.push(resolve));
    await this.session.send(prompt);
    return completed;
  }
}

export async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-probe-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function startProbe(dir: string, options: ProbeOptions = {}): Probe {
  const { session: overrides, tools } = options;
  return new Probe(
    Session.open({
      cwd: dir,
      model: process.env.KILN_PROBE_MODEL,
      includePartialMessages: true,
      ...(tools ? { mcpServers: { kiln: createKilnServer(tools) } } : {}),
      ...overrides,
    }),
  );
}

export function log(message = ''): void {
  process.stdout.write(`${message}\n`);
}

export function field(label: string, value: unknown): void {
  log(`${label.padEnd(14)}${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

export function verdict(ok: boolean, label: string): void {
  log(`\n${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

/** Polls until `predicate` holds or the deadline passes, then returns the last value. */
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
}

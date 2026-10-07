import type { Checkpoint, RemoteStatus, PublishTarget } from './api.ts';

export type Outstanding =
  | { kind: 'permission'; requestId: string; toolName: string; input: unknown; title: string; description: string; canRemember: boolean }
  | { kind: 'question'; requestId: string; question: string; choices: string[] };

export type AppState = {
  dir: string;
  preview: { running: boolean; url: string | null; framework: string | null };
  sessionId: string | null;
  checkpoints: Checkpoint[];
  costUsd: number;
  busy: boolean;
  lastError: string | null;
  outstanding: Outstanding[];
};

export type ElementReport = {
  selector: string;
  tag: string;
  attributes: Record<string, string>;
  outerHTML: string;
  accessibleName: string | null;
  rect: { x: number; y: number; width: number; height: number };
  domPath: string;
};

export type ResolvedElement = {
  id: string;
  tag: string;
  attributes: Record<string, string>;
  file: string;
  line: number;
  column: number;
  snippet: string;
};

export type SelectionResult = { report: ElementReport | null; exact: ResolvedElement | null };

export type Checkpoint = {
  id: string;
  promptUuid: string;
  parent: string | null;
  at: string;
  message: string;
  files: string[];
  costUsd: number;
};

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
};

export type PublishTarget = {
  kind: 'static' | 'node' | 'container' | 'unsupported';
  label: string;
  detail: string;
};

/** Everything the daemon emits, flattened for rendering. */
export type DaemonEvent = Record<string, any> & { kind: string };

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? response.statusText);
  return payload as T;
}

export const api = {
  state: () => fetch('/api/state').then((r) => r.json() as Promise<AppState>),
  outstanding: () =>
    fetch('/api/outstanding')
      .then((r) => r.json() as Promise<{ outstanding: Outstanding[] }>)
      .then((d) => d.outstanding)
      .catch(() => [] as Outstanding[]),

  prompt: (text: string) => post<{ promptUuid: string }>('/api/prompt', { text }),
  interrupt: () => post<{ ok: boolean }>('/api/interrupt', {}),
  answerPermission: (requestId: string, allow: boolean, remember = false) =>
    post<{ ok: boolean }>('/api/permission', { requestId, allow, remember }),
  answerQuestion: (requestId: string, answer: string) =>
    post<{ ok: boolean }>('/api/question', { requestId, answer }),

  restore: (checkpointId: string) => post<{ ok: boolean }>('/api/restore', { checkpointId }),
  setDevCommand: (command: string) =>
    post<{ ok: boolean; preview: AppState['preview'] }>('/api/dev-command', { command }),

  select: (selector: string, kilnId: string | null) =>
    post<SelectionResult>('/api/select', { selector, kilnId }),
  editInstruction: (selector: string, kilnId: string | null, intent: string) =>
    post<{ instruction: string }>('/api/edit-instruction', { selector, kilnId, intent }),

  remote: () => fetch('/api/remote').then((r) => r.json() as Promise<RemoteStatus>),
  connectRemote: (url: string) => post<RemoteStatus>('/api/remote/connect', { url }),
  push: () => post<{ url: string; branch: string }>('/api/remote/push', {}),
  openPullRequest: () => post<{ url: string; number: number | null }>('/api/remote/pr', {}),

  publishTarget: () => fetch('/api/publish').then((r) => r.json() as Promise<PublishTarget>),
  writePublishScaffold: () =>
    post<{ path: string; target: PublishTarget }>('/api/publish/scaffold', {}),
};

export function subscribe(onEvent: (event: DaemonEvent) => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      // Ignore frames we cannot parse rather than dropping the stream.
    }
  };
  return () => source.close();
}

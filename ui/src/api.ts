export type Checkpoint = {
  id: string;
  promptUuid: string;
  parent: string | null;
  at: string;
  message: string;
  files: string[];
  costUsd: number;
};

export type AppState = {
  dir: string;
  preview: { running: boolean; url: string | null; framework: string | null };
  sessionId: string | null;
  checkpoints: Checkpoint[];
  costUsd: number;
  busy: boolean;
  lastError: string | null;
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return (await response.json()) as T;
}

export const api = {
  state: () => fetch('/api/state').then((r) => r.json() as Promise<AppState>),

  prompt: (text: string) => post<{ promptUuid: string }>('/api/prompt', { text }),

  interrupt: () => post<{ ok: boolean }>('/api/interrupt', {}),

  answerPermission: (requestId: string, allow: boolean, remember = false) =>
    post<{ ok: boolean }>('/api/permission', { requestId, allow, remember }),

  answerQuestion: (requestId: string, answer: string) =>
    post<{ ok: boolean }>('/api/question', { requestId, answer }),

  restore: (checkpointId: string) => post<{ ok: boolean }>('/api/restore', { checkpointId }),

  setDevCommand: (command: string) =>
    post<{ ok: boolean; preview: AppState['preview'] }>('/api/dev-command', { command }),

  inspect: (selector: string) =>
    post<{ report: ElementReport | null }>('/api/inspect', { selector }).then((r) => r.report),
};

export function subscribe(onEvent: (event: any) => void): () => void {
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

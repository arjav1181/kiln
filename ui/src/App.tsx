import { useEffect, useRef, useState } from 'react';
import {
  api,
  subscribe,
  type AppState,
  type DaemonEvent,
  type Outstanding,
  type PublishTarget,
  type RemoteStatus,
  type SelectionResult,
} from './api.ts';
import { ToolRow, type ToolCall } from './components/ToolRow.tsx';

type Turn = {
  turnId: string;
  prompt: string;
  text: string;
  thinking: string;
  tools: ToolCall[];
  costUsd: number;
  ended: boolean;
  stopReason?: string | null;
  files?: string[];
};

type LogLine = { at: number; kind: string; text: string };

type Toast = { id: number; text: string; tone: 'info' | 'err' | 'ok' };

type Selection = { report: SelectionResult['report']; exact: SelectionResult['exact']; kilnId: string | null };

const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const LOG_CAP = 500;

const EXAMPLES: Array<[string, string]> = [
  ['A todo app', 'Build a todo app with add, complete and delete, persisted in localStorage.'],
  ['A landing page', 'Create a landing page for a coffee subscription with a hero, pricing and signup form.'],
  ['Fix a bug', 'The submit button does nothing when the form is empty. Find out why and fix it.'],
  ['Start from nothing', 'Make a markdown notes app that saves to a file on disk.'],
];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'preview' | 'history' | 'ship' | 'log'>('preview');
  const [permission, setPermission] = useState<Outstanding | null>(null);
  const [question, setQuestion] = useState<Outstanding | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [publish, setPublish] = useState<PublishTarget | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [devCommand, setDevCommand] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [intent, setIntent] = useState('');
  const [frameNonce, setFrameNonce] = useState(0);

  const streamRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const toastId = useRef(0);

  const busy = state?.busy ?? false;
  const previewUrl = state?.preview.url ?? null;
  const cost = turns.reduce((sum, t) => sum + t.costUsd, 0);

  const toast = (text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  };

  const note = (kind: string, text: string) => {
    // Streaming deltas would drown the log; the chat already shows them.
    if (!text) return;
    setLog((l) => [...l, { at: Date.now(), kind, text }].slice(-LOG_CAP));
  };

  const patch = (turnId: string, change: (t: Turn) => Turn) =>
    setTurns((list) => list.map((t) => (t.turnId === turnId ? change(t) : t)));

  /** Puts waiting prompts back on screen, so a reconnect never loses one. */
  const syncOutstanding = async () => {
    for (const item of await api.outstanding()) {
      if (item.kind === 'permission') setPermission(item);
      else setQuestion(item);
    }
  };

  useEffect(() => {
    void api.state().then(setState);
    void syncOutstanding();
    void api.remote().then(setRemote).catch(() => {});
    void api.publishTarget().then(setPublish).catch(() => {});
    boxRef.current?.focus();

    return subscribe((event) => {
      note(event.kind, describe(event));

      switch (event.kind) {
        case 'busy':
          setState((s) => (s ? { ...s, busy: event.busy } : s));
          if (!event.busy) {
            void syncOutstanding();
            void api.state().then(setState);
          }
          break;

        case 'preview':
          setState((s) => (s ? { ...s, preview: { ...s.preview, url: event.url, framework: event.framework } } : s));
          setFrameNonce((n) => n + 1);
          break;

        case 'turn.start':
          setTurns((t) => [
            ...t,
            { turnId: event.turnId, prompt: '', text: '', thinking: '', tools: [], costUsd: 0, ended: false },
          ]);
          break;

        case 'text':
          patch(event.turnId, (t) => ({ ...t, text: t.text + event.delta }));
          break;

        case 'thinking':
          patch(event.turnId, (t) => ({ ...t, thinking: t.thinking + event.delta }));
          break;

        case 'tool.start':
          patch(event.turnId, (t) => ({
            ...t,
            tools: [
              ...t.tools,
              { id: event.toolUseId, name: event.name, input: event.input, startedAt: Date.now(), running: true },
            ],
          }));
          break;

        case 'tool.result':
          patch(event.turnId, (t) => ({
            ...t,
            tools: t.tools.map((tool) =>
              tool.id === event.toolUseId
                ? { ...tool, isError: event.isError, output: event.output, endedAt: Date.now(), running: false }
                : tool,
            ),
          }));
          break;

        case 'turn.end':
          patch(event.turnId, (t) => ({ ...t, ended: true, costUsd: event.costUsd, stopReason: event.stopReason }));
          break;

        case 'turn.done':
          patch(event.promptUuid, (t) => ({ ...t, files: event.files }));
          void api.state().then(setState);
          break;

        case 'permission':
          setPermission(event);
          break;
        case 'question':
          setQuestion(event);
          break;

        case 'turn.retrying':
          toast(`Retrying (attempt ${event.attempt}) — ${event.reason}`, 'info');
          break;
        case 'preview.captured':
          toast(`Preview sent to the agent: ${event.reason}`, 'ok');
          break;
        case 'preview.skipped':
          toast(`Preview not sent: ${event.reason}`);
          break;
        case 'history.disabled':
          toast(`Version history off — ${event.reason}`, 'err');
          break;
        case 'deps.starting':
          toast(`Installing ${event.manager} dependencies…`);
          break;
        case 'deps.done':
          toast(
            event.ok ? `Installed ${event.manager} dependencies` : `Install failed: ${event.detail}`,
            event.ok ? 'ok' : 'err',
          );
          break;
        case 'fatal':
          toast(event.message, 'err');
          setState((s) => (s ? { ...s, lastError: event.message } : s));
          break;
        case 'restored':
          toast('Restored', 'ok');
          void api.state().then(setState);
          break;
      }
    });
  }, []);

  useEffect(() => {
    const onMessage = (message: MessageEvent) => {
      const data = message.data as { type?: string; selector?: string; kilnId?: string | null };
      if (data?.type === 'kiln:select' && data.selector) {
        void api.select(data.selector, data.kilnId ?? null).then((result) => {
          setSelection({ report: result.report, exact: result.exact, kilnId: data.kilnId ?? null });
          setIntent('');
          note('select', `${data.selector}${result.exact ? ` -> ${result.exact.file}:${result.exact.line}` : ''}`);
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, permission, question]);

  const send = async (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    setDraft('');
    setTurns((t) => [
      ...t,
      { turnId: `pending-${t.length}`, prompt: value, text: '', thinking: '', tools: [], costUsd: 0, ended: false },
    ]);
    try {
      await api.prompt(value);
      boxRef.current?.focus();
    } catch (error) {
      toast((error as Error).message, 'err');
    }
  };

  const sendEdit = async (target: Selection, want: string) => {
    if (!target.exact) {
      const label = target.report
        ? `<${target.report.tag}${target.report.attributes.id ? '#' + target.report.attributes.id : ''}> in the preview`
        : 'the element I alt-clicked in the preview';
      setDraft(`${label}: ${want}`);
      setSelection(null);
      return;
    }
    try {
      const { instruction } = await api.editInstruction(target.report?.selector ?? '', target.kilnId, want);
      setDraft(instruction);
      setSelection(null);
      toast(`Targeting ${target.exact.file}:${target.exact.line}`, 'ok');
    } catch (error) {
      toast((error as Error).message, 'err');
    }
  };

  const decide = async (allow: boolean, remember = false) => {
    if (!permission || permission.kind !== 'permission') return;
    await api.answerPermission(permission.requestId, allow, remember);
    setPermission(null);
  };

  const answer = async (value: string) => {
    if (!question || question.kind !== 'question') return;
    await api.answerQuestion(question.requestId, value);
    setQuestion(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <span className="name">Kiln</span>
        </div>
        <span className="pill mono" title={state?.dir}>{shortPath(state?.dir ?? '')}</span>
        <span className={`pill ${busy ? 'busy' : 'ok'}`}>
          <span className="dot" />
          {busy ? 'working' : 'idle'}
        </span>
        {state?.preview.framework && <span className="pill">{state.preview.framework}</span>}
        <span className="spacer" />
        <span className="pill" title="Total spend this session">{money(cost)}</span>
        <span className="pill" title="Turns this session">{turns.length}</span>
        {busy && (
          <button className="danger" onClick={() => void api.interrupt()}>
            Stop
          </button>
        )}
      </header>

      <div className="body">
        <section className="chat">
          <div className="stream" ref={streamRef}>
            <div className="stream-inner">
              {turns.length === 0 ? (
                <div className="empty-state">
                  <h2>What are we building?</h2>
                  <p>
                    Describe it in your own words. Kiln writes the code, runs it, shows you the
                    result, and keeps every version so you can go back.
                  </p>
                  <div className="examples">
                    {EXAMPLES.map(([title, prompt]) => (
                      <button key={title} onClick={() => void send(prompt)}>
                        <b>{title}</b>
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((turn) => (
                  <div key={turn.turnId} className="turn">
                    {turn.prompt && (
                      <div className="turn-user">
                        <div className="bubble">{turn.prompt}</div>
                      </div>
                    )}

                    <div className="agent-out">
                      {turn.thinking && (
                        <div className="thinking">
                          <div className="thinking-head">thinking</div>
                          {turn.thinking}
                        </div>
                      )}

                      {turn.tools.length > 0 && (
                        <div className="tools">
                          {turn.tools.map((tool) => (
                            <ToolRow key={tool.id} tool={tool} />
                          ))}
                        </div>
                      )}

                      {turn.text && <div className="prose">{turn.text}</div>}

                      {turn.ended && (
                        <div className="turn-foot">
                          <span>{money(turn.costUsd)}</span>
                          {turn.stopReason && (
                            <>
                              <span className="sep">·</span>
                              <span>{turn.stopReason}</span>
                            </>
                          )}
                          {turn.files && turn.files.length > 0 && (
                            <>
                              <span className="sep">·</span>
                              <span>
                                {turn.files.length} file{turn.files.length === 1 ? '' : 's'}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="composer">
            <div className="composer-inner">
              <div className="composer-box">
                <textarea
                  ref={boxRef}
                  rows={1}
                  value={draft}
                  placeholder="Describe a change, or ask a question…"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(draft);
                    }
                  }}
                />
                <button className="primary" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
                  {busy ? 'Working…' : 'Send'}
                </button>
              </div>
              <div className="composer-hint">
                <span>
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                </span>
                <span>Alt-click the preview to select an element</span>
              </div>
            </div>
          </div>
        </section>

        <aside className="side">
          <div className="tabs">
            {(['preview', 'history', 'ship', 'log'] as const).map((name) => (
              <button key={name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </div>

          {tab === 'preview' && (
            <div className="panel">
              {previewUrl ? (
                <>
                  <div className="preview-box">
                    <div className="preview-bar">
                      <span className="url">{previewUrl}</span>
                      <button className="ghost" onClick={() => setFrameNonce((n) => n + 1)} title="Reload">
                        ⟳
                      </button>
                      <button className="ghost" onClick={() => window.open(previewUrl, '_blank')}>
                        ↗
                      </button>
                    </div>
                    <div className="preview-frame">
                      <iframe key={`${previewUrl}:${frameNonce}`} src={previewUrl} title="preview" />
                    </div>
                  </div>

                  {selection && (
                    <div style={{ marginTop: 12 }}>
                      <h3>Selected</h3>
                      {selection.exact ? (
                        <>
                          <div className="kv">
                            <span className="k">element</span>
                            <span className="v">
                              {selection.exact.tag}#{selection.exact.attributes.id ?? ''}
                            </span>
                          </div>
                          <div className="kv">
                            <span className="k">source</span>
                            <span className="v">
                              {selection.exact.file}:{selection.exact.line}
                            </span>
                          </div>
                          <div className="kv">
                            <span className="k">name</span>
                            <span className="v">{selection.exact.attributes.className ?? '—'}</span>
                          </div>
                        </>
                      ) : (
                        <p className="note">No exact source index for that element yet.</p>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <input
                          type="text"
                          placeholder="e.g. make it red"
                          value={intent}
                          onChange={(e) => setIntent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && intent.trim()) void sendEdit(selection, intent.trim());
                          }}
                        />
                        <button
                          className="primary"
                          disabled={!intent.trim()}
                          onClick={() => void sendEdit(selection, intent.trim())}
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h3>No preview yet</h3>
                  <p className="note">
                    Nothing to serve. Describe what you want and Kiln will create the project, or
                    point it at an existing app.
                  </p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      placeholder="python manage.py runserver"
                      value={devCommand}
                      onChange={(e) => setDevCommand(e.target.value)}
                    />
                    <button
                      disabled={!devCommand.trim()}
                      onClick={() => void api.setDevCommand(devCommand.trim()).catch((error) => toast((error as Error).message, 'err'))}
                    >
                      Start
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="panel">
              <h3>Versions</h3>
              {(state?.checkpoints ?? []).length === 0 ? (
                <p className="note">Nothing committed yet.</p>
              ) : (
                <div className="timeline">
                  {[...(state?.checkpoints ?? [])].reverse().map((checkpoint, index, all) => (
                    <div
                      key={checkpoint.id}
                      className={`tl-item${index === 0 ? ' on' : ''}`}
                      onClick={() =>
                        void api.restore(checkpoint.id).catch((error) => toast((error as Error).message, 'err'))
                      }
                      title={`${checkpoint.id.slice(0, 8)} — click to restore`}
                    >
                      <span className="msg">{checkpoint.message || 'turn'}</span>
                      <span className="meta">
                        {checkpoint.files.length}f · {money(checkpoint.costUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <h3 className="mt">Session</h3>
              <div className="kv">
                <span className="k">branch</span>
                <span className="v">kiln</span>
              </div>
              <div className="kv">
                <span className="k">versions</span>
                <span className="v">{state?.checkpoints.length ?? 0}</span>
              </div>
              <div className="kv">
                <span className="k">spent</span>
                <span className="v">{money(state?.costUsd ?? 0)}</span>
              </div>
            </div>
          )}

          {tab === 'ship' && (
            <div className="panel">
              <h3>Publish</h3>
              {publish ? (
                <>
                  <div className="kv">
                    <span className="k">target</span>
                    <span className="v">{publish.label}</span>
                  </div>
                  <p className="note" style={{ marginTop: 8 }}>{publish.detail}</p>
                </>
              ) : (
                <p className="note">Working it out…</p>
              )}
              {publish && publish.kind !== 'container' && (
                <button
                  style={{ width: '100%' }}
                  onClick={() => void api.writePublishScaffold().then(() => toast('Dockerfile written', 'ok'))}
                >
                  Write a Dockerfile
                </button>
              )}

              <h3 className="mt">GitHub</h3>
              {remote?.configured ? (
                <>
                  <div className="kv">
                    <span className="k">remote</span>
                    <span className="v">{remote.url}</span>
                  </div>
                  <div className="kv">
                    <span className="k">sync</span>
                    <span className="v">
                      {remote.ahead} ahead · {remote.behind} behind
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      style={{ flex: 1 }}
                      disabled={busy || remote.ahead === 0}
                      onClick={() =>
                        void api
                          .push()
                          .then(() => {
                            toast('Pushed', 'ok');
                            void api.remote().then(setRemote);
                          })
                          .catch((error) => toast((error as Error).message, 'err'))
                      }
                    >
                      Push
                    </button>
                    <button
                      className="primary"
                      style={{ flex: 1 }}
                      disabled={busy || !remote.ghAuthed}
                      title={remote.ghAuthed ? '' : 'Sign in with the gh CLI first'}
                      onClick={() =>
                        void api
                          .openPullRequest()
                          .then((r) => toast(`Pull request: ${r.url}`, 'ok'))
                          .catch((error) => toast((error as Error).message, 'err'))
                      }
                    >
                      Pull request
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="note">
                    Kiln pushes its own branch, never your main, so the agent's work stays
                    reviewable.
                  </p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      placeholder="git@github.com:you/repo.git"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                    />
                    <button
                      disabled={!repoUrl.trim()}
                      onClick={() =>
                        void api.connectRemote(repoUrl.trim()).then(setRemote).catch((error) => toast((error as Error).message, 'err'))
                      }
                    >
                      Connect
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'log' && (
            <div className="panel">
              <h3>Event log · last {log.length}</h3>
              {log.length === 0 ? (
                <p className="note">Nothing yet.</p>
              ) : (
                log
                  .slice()
                  .reverse()
                  .map((line, i) => (
                    <div className="logline" key={`${line.at}-${i}`}>
                      <span className="t">{clock(line.at)}</span>
                      <span className={`k ${toneClass(line.kind)}`}>{line.kind}</span>
                      <span className="m">{line.text}</span>
                    </div>
                  ))
              )}
            </div>
          )}
        </aside>
      </div>

      {permission && permission.kind === 'permission' && (
        <div className="overlay">
          <div className="modal">
            <div className="modal-head">
              <h3>{permission.title}</h3>
              <div className="sub">{permission.description || permission.toolName}</div>
            </div>
            <div className="modal-body">
              <pre>{JSON.stringify(permission.input, null, 2)}</pre>
            </div>
            <div className="modal-foot">
              {permission.canRemember && (
                <button onClick={() => void decide(true, true)}>Always allow</button>
              )}
              <button className="danger" onClick={() => void decide(false)}>
                Deny
              </button>
              <button className="primary" onClick={() => void decide(true)}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}

      {question && question.kind === 'question' && (
        <div className="overlay">
          <div className="modal">
            <div className="modal-head">
              <h3>The agent has a question</h3>
              <div className="sub">{question.question}</div>
            </div>
            <div className="modal-foot">
              <input
                type="text"
                placeholder="Your answer"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) void answer(e.currentTarget.value.trim());
                }}
              />
              {question.choices.map((choice) => (
                <button key={choice} onClick={() => void answer(choice)}>
                  {choice}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function shortPath(dir: string): string {
  const parts = dir.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}

function toneClass(kind: string): string {
  if (kind.startsWith('turn')) return 'ev-turn';
  if (kind.includes('tool') || kind === 'permission' || kind === 'question') return 'ev-tool';
  if (kind === 'fatal' || kind === 'history.disabled') return 'ev-err';
  if (kind === 'deps.done' || kind === 'preview.captured' || kind === 'restored') return 'ev-ok';
  return 'ev-info';
}

function describe(event: DaemonEvent): string {
  const { kind, turnId, delta, sessionId, ...rest } = event;
  void turnId; void delta; void sessionId;
  switch (kind) {
    case 'text':
    case 'thinking':
      return '';
    case 'tool.start':
      return `${rest.name}`;
    case 'tool.result':
      return `${rest.isError ? 'failed' : 'ok'} · ${String(rest.output ?? '').slice(0, 120)}`;
    case 'turn.end':
      return `${rest.stopReason ?? ''} · $${(rest.costUsd ?? 0).toFixed(4)}`;
    case 'turn.done':
      return `${(rest.files ?? []).length} files · ${rest.checkpointId ? rest.checkpointId.slice(0, 8) : 'no checkpoint'}`;
    case 'server.log':
      return String(rest.line ?? '');
    default: {
      const text = JSON.stringify(rest);
      return text === '{}' ? '' : text.slice(0, 160);
    }
  }
}

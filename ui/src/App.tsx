import { useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, type AppState, type ElementReport } from './api.ts';
import './styles.css';

type ToolCall = { id: string; name: string; input?: unknown; isError?: boolean };
type Turn = { turnId: string; prompt: string; text: string; thinking: string; tools: ToolCall[]; ended: boolean; costUsd: number };

type Permission = {
  requestId: string;
  toolName: string;
  input: unknown;
  title: string;
  description: string;
  canRemember: boolean;
};

type Question = { requestId: string; question: string; choices: string[] };

const money = (value: number) => (value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [permission, setPermission] = useState<Permission | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [devCommand, setDevCommand] = useState('');
  const [selection, setSelection] = useState<ElementReport | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameKey = useRef(0);

  const busy = state?.busy ?? false;
  const previewUrl = state?.preview.url ?? null;

  const patch = (turnId: string, change: (turn: Turn) => Turn) =>
    setTurns((current) => current.map((t) => (t.turnId === turnId ? change(t) : t)));

  useEffect(() => {
    void api.state().then(setState);

    return subscribe((event) => {
      switch (event.kind) {
        case 'busy':
          setState((s) => (s ? { ...s, busy: event.busy } : s));
          break;
        case 'preview':
          setState((s) => (s ? { ...s, preview: { ...s.preview, url: event.url, framework: event.framework } } : s));
          break;
        case 'turn.start':
          setTurns((current) => [
            ...current,
            { turnId: event.turnId, prompt: '', text: '', thinking: '', tools: [], ended: false, costUsd: 0 },
          ]);
          break;
        case 'text':
          patch(event.turnId, (t) => ({ ...t, text: t.text + event.delta }));
          break;
        case 'thinking':
          patch(event.turnId, (t) => ({ ...t, thinking: t.thinking + event.delta }));
          break;
        case 'tool.start':
          patch(event.turnId, (t) => ({ ...t, tools: [...t.tools, { id: event.toolUseId, name: event.name, input: event.input }] }));
          break;
        case 'tool.result':
          patch(event.turnId, (t) => ({
            ...t,
            tools: t.tools.map((tool) => (tool.id === event.toolUseId ? { ...tool, isError: event.isError } : tool)),
          }));
          break;
        case 'turn.end':
          patch(event.turnId, (t) => ({ ...t, ended: true, costUsd: event.costUsd }));
          break;
        case 'turn.done':
          setState((s) => (s ? { ...s, costUsd: s.costUsd + event.costUsd } : s));
          void api.state().then(setState);
          break;
        case 'permission':
          setPermission({
            requestId: event.requestId,
            toolName: event.toolName,
            input: event.input,
            title: event.title,
            description: event.description,
            canRemember: event.canRemember,
          });
          break;
        case 'question':
          setQuestion({ requestId: event.requestId, question: event.question, choices: event.choices });
          break;
        case 'preview.captured':
          setNotice({ kind: 'info', text: `Preview captured: ${event.reason}` });
          break;
        case 'preview.skipped':
          setNotice({ kind: 'info', text: `Preview not sent: ${event.reason}` });
          break;
        case 'fatal':
          setState((s) => (s ? { ...s, lastError: event.message } : s));
          break;
        case 'server.log':
          setNotice({ kind: 'info', text: event.line });
          break;
      }
    });
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'kiln:select') {
        void api.inspect((event.data as { selector: string }).selector).then(setSelection);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const cost = useMemo(() => turns.reduce((sum, turn) => sum + turn.costUsd, 0), [turns]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    // The prompt is echoed optimistically; turn.start appends the real turn.
    setTurns((current) => [
      ...current,
      { turnId: `pending-${current.length}`, prompt: text, text: '', thinking: '', tools: [], ended: false, costUsd: 0 },
    ]);
    try {
      await api.prompt(text);
    } catch (error) {
      setState((s) => (s ? { ...s, lastError: (error as Error).message } : s));
    }
  };

  const restore = async (id: string) => {
    try {
      await api.restore(id);
      await api.state().then(setState);
      setNotice({ kind: 'info', text: 'Restored' });
    } catch (error) {
      setState((s) => (s ? { ...s, lastError: (error as Error).message } : s));
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Kiln</h1>
        <span className="dir">{state?.dir}</span>
        <span className="spacer" />
        <span className="stat">
          {busy ? <span className="badge warn">working</span> : <span className="badge ok">idle</span>}
        </span>
        <span className="stat">{money(cost)}</span>
        {busy && (
          <button onClick={() => void api.interrupt()}>Stop</button>
        )}
      </header>

      {state?.lastError && <div className="banner error">{state.lastError}</div>}
      {notice && (
        <div className="banner info" onClick={() => setNotice(null)}>
          {notice.text}
        </div>
      )}

      <div className="panes">
        <div className="pane chat">
          <div className="scroll" ref={scrollRef}>
            {turns.length === 0 && (
              <div className="empty">
                Describe what you want. Kiln scaffolds the app, runs it, and shows you the
                preview while the agent works.
              </div>
            )}
            {turns.map((turn) => (
              <div key={turn.turnId} className="turn">
                {turn.prompt && <div className="prompt">{turn.prompt}</div>}
                {turn.thinking && <div className="thinking">{turn.thinking}</div>}
                {turn.tools.map((tool) => (
                  <div key={tool.id} className={`tool${tool.isError ? ' error' : ''}`}>
                    <span className="name">{tool.name}</span>
                    {tool.isError ? ' failed' : ''}
                  </div>
                ))}
                {turn.text && <div className="text">{turn.text}</div>}
                {turn.ended && (
                  <div className="meta">
                    {turn.costUsd ? money(turn.costUsd) : 'no spend'}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="composer">
            <div className="row">
              <textarea
                value={draft}
                placeholder="Ask for a change…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              <button className="primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          </div>
        </div>

        <div className="pane side">
          {previewUrl ? (
            <div className="frame">
              <iframe
                key={`${previewUrl}:${frameKey.current}`}
                src={previewUrl}
                title="preview"
                onLoad={() => { frameKey.current += 1; }}
              />
            </div>
          ) : (
            <div className="section">
              <h2>No preview</h2>
              <div className="empty">
                Kiln could not work out how to run this project. Give it the dev command and
                it will serve the result.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="npm run dev"
                  value={devCommand}
                  onChange={(e) => setDevCommand(e.target.value)}
                />
                <button
                  disabled={!devCommand.trim()}
                  onClick={() => void api.setDevCommand(devCommand.trim())}
                >
                  Start
                </button>
              </div>
            </div>
          )}

          {selection && (
            <div className="section">
              <h2>Selected</h2>
              <div className="checkpoint">
                <span className="msg">
                  {selection.tag}#{selection.attributes.id ?? ''}
                </span>
                <button onClick={() => setSelection(null)}>clear</button>
              </div>
              <div className="files">{selection.domPath}</div>
            </div>
          )}

          <div className="section" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <h2>History</h2>
            {(state?.checkpoints ?? []).length === 0 && <div className="empty">No checkpoints yet.</div>}
            {[...(state?.checkpoints ?? [])].reverse().map((checkpoint, index, all) => (
              <div
                key={checkpoint.id}
                className={`checkpoint${index === 0 ? ' current' : ''}`}
                onClick={() => void restore(checkpoint.id)}
                title={`${checkpoint.files.length} files · ${checkpoint.id.slice(0, 8)}`}
              >
                <span className="msg">{checkpoint.message || 'turn'}</span>
                <span className="files">{checkpoint.files.length}</span>
                <span className="cost">{money(checkpoint.costUsd)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {permission && (
        <div className="overlay">
          <div className="modal">
            <h3>{permission.title}</h3>
            <div className="sub">{permission.description || permission.toolName}</div>
            <pre>{JSON.stringify(permission.input, null, 2)}</pre>
            <div className="actions">
              {permission.canRemember && (
                <button onClick={() => void decide(permission.requestId, true, true)}>
                  Always allow
                </button>
              )}
              <button onClick={() => void decide(permission.requestId, false)}>Deny</button>
              <button className="primary" onClick={() => void decide(permission.requestId, true, false)}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}

      {question && (
        <div className="overlay">
          <div className="modal">
            <h3>The agent has a question</h3>
            <div className="sub">{question.question}</div>
            <div className="actions">
              <input
                type="text"
                placeholder="Your answer"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const input = e.currentTarget;
                    void answerQuestion(question.requestId, input.value);
                  }
                }}
              />
            </div>
            {question.choices.length > 0 && (
              <div className="choices">
                {question.choices.map((choice) => (
                  <button key={choice} onClick={() => void answerQuestion(question.requestId, choice)}>
                    {choice}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  async function decide(requestId: string, allow: boolean, remember = false) {
    await api.answerPermission(requestId, allow, remember);
    setPermission(null);
  }

  async function answerQuestion(requestId: string, answer: string) {
    await api.answerQuestion(requestId, answer);
    setQuestion(null);
  }
}

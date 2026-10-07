import { useState } from 'react';

export type ToolCall = {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  running?: boolean;
};

const shorten = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  const text = JSON.stringify(value);
  return text === '{}' ? '' : text;
};

const pretty = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const duration = (tool: ToolCall): string => {
  if (!tool.startedAt) return '';
  const end = tool.endedAt ?? Date.now();
  const ms = end - tool.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

export function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = shorten(tool.input);
  const hasBody = tool.output !== undefined || summary !== '';

  return (
    <div className={`tool${open ? ' open' : ''}${tool.isError ? ' error' : ''}`}>
      <div className="tool-head" onClick={() => hasBody && setOpen((v) => !v)}>
        <span className="caret">▸</span>
        <span className="name">{tool.name}</span>
        <span className="detail">
          {summary || (tool.running ? 'running…' : tool.isError ? 'failed' : 'done')}
        </span>
        {duration(tool) && <span className="dur">{duration(tool)}</span>}
      </div>
      {open && hasBody && (
        <div className="tool-body">
          {summary !== '' && (
            <>
              <div className="lbl">input</div>
              <pre>{pretty(tool.input)}</pre>
            </>
          )}
          {tool.output !== undefined && (
            <>
              <div className="lbl">{tool.isError ? 'error' : 'output'}</div>
              <pre className={tool.isError ? 'err' : undefined}>{tool.output || '(empty)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

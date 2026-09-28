import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './queue.ts';
import type { KilnEvent, PermissionDecision } from './events.ts';

export type PermissionRequest = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  title: string | undefined;
  description: string | undefined;
  canRemember: boolean;
};

export type UserContent = string | Array<Record<string, unknown>>;

export interface SessionConfig {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  resume?: string;
  resumeSessionAt?: string;
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export class Session {
  static open(config: SessionConfig): Session {
    const session = new Session(config);
    void session.#pump();
    return session;
  }

  readonly #config: SessionConfig;
  readonly #inbox = new AsyncQueue<SDKUserMessage>();
  readonly #events = new AsyncQueue<KilnEvent>();
  readonly #query: Query;

  #sessionId = '';
  #turnId = '';
  #ready!: () => void;
  readonly #readyPromise: Promise<void>;

  private constructor(config: SessionConfig) {
    this.#config = config;
    this.#readyPromise = new Promise((resolve) => {
      this.#ready = resolve;
    });

    this.#query = query({ prompt: this.#inbox, options: this.#options() });
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get events(): AsyncIterable<KilnEvent> {
    return this.#events;
  }

  whenReady(): Promise<void> {
    return this.#readyPromise;
  }

  /** Mints the prompt uuid that `resumeSessionAt` later keys on. */
  async send(content: UserContent): Promise<string> {
    const uuid = randomUUID();
    this.#turnId = uuid;
    this.#events.push({ kind: 'turn.start', turnId: uuid, promptUuid: uuid });
    this.#inbox.push({
      type: 'user',
      message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
      parent_tool_use_id: null,
      uuid,
      ...(this.#sessionId ? { session_id: this.#sessionId } : {}),
    });
    return uuid;
  }

  interrupt(): Promise<unknown> {
    return this.#query.interrupt();
  }

  async close(): Promise<void> {
    this.#inbox.close();
    await this.#query.return(undefined).catch(() => {});
    this.#events.close();
  }

  #options(): Options {
    const { onPermission, ...rest } = this.#config;
    const options: Options = {
      ...rest,
      canUseTool: onPermission ? this.#canUseTool(onPermission) : undefined,
    };
    return options;
  }

  #canUseTool(onPermission: NonNullable<SessionConfig['onPermission']>): CanUseTool {
    return async (toolName, input, ctx) => {
      const decision = await onPermission({
        requestId: ctx.requestId,
        toolUseId: ctx.toolUseID,
        toolName,
        input,
        title: ctx.title,
        description: ctx.description,
        canRemember: !ctx.suppressAlwaysAllowRule && (ctx.suggestions?.length ?? 0) > 0,
      });

      if (!decision.allow) {
        return { behavior: 'deny', message: decision.reason, toolUseID: ctx.toolUseID };
      }
      return {
        behavior: 'allow',
        toolUseID: ctx.toolUseID,
        updatedPermissions: decision.remember ? ctx.suggestions : undefined,
      };
    };
  }

  async #pump(): Promise<void> {
    try {
      for await (const message of this.#query) this.#handle(message);
    } catch (error) {
      this.#events.push({ kind: 'fatal', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#events.close();
    }
  }

  #handle(message: SDKMessage): void {
    if ('session_id' in message && message.session_id && !this.#sessionId) {
      this.#sessionId = message.session_id;
      this.#ready();
    }

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.#events.push({ kind: 'session.ready', sessionId: message.session_id });
        }
        return;
      case 'stream_event':
        this.#handleStreamEvent(message);
        return;
      case 'assistant':
        this.#handleAssistant(message);
        return;
      case 'user':
        this.#handleToolResult(message);
        return;
      case 'result':
        this.#handleResult(message);
        return;
      default:
        return;
    }
  }

  #turn(message: { user_message_uuid?: string }): string {
    return message.user_message_uuid ?? this.#turnId;
  }
  #handleStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const event = message.event;
    if (event.type !== 'content_block_delta') return;
    const turnId = this.#turn(message);
    if (event.delta.type === 'text_delta') {
      this.#events.push({ kind: 'text', turnId, delta: event.delta.text });
    } else if (event.delta.type === 'thinking_delta') {
      this.#events.push({ kind: 'thinking', turnId, delta: event.delta.thinking });
    }
  }

  #handleAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const turnId = this.#turn(message);
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        this.#events.push({
          kind: 'tool.start',
          turnId,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (!this.#config.includePartialMessages && block.type === 'text') {
        this.#events.push({ kind: 'text', turnId, delta: block.text });
      } else if (!this.#config.includePartialMessages && block.type === 'thinking') {
        this.#events.push({ kind: 'thinking', turnId, delta: block.thinking });
      }
    }
  }

  #handleToolResult(message: Extract<SDKMessage, { type: 'user' }>): void {
    const content = message.message.content;
    if (typeof content === 'string') return;
    const turnId = this.#turnId;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      this.#events.push({
        kind: 'tool.result',
        turnId,
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        output: flattenToolResult(block.content),
      });
    }
  }

  #handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
    this.#events.push({
      kind: 'turn.end',
      turnId: this.#turn(message),
      promptUuid: message.user_message_uuid ?? this.#turnId,
      costUsd: message.total_cost_usd,
      isError: message.is_error,
      stopReason: message.stop_reason,
      result: 'result' in message ? message.result : message.errors.join('\n'),
    });
    this.#turnId = '';
  }
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = part as { type?: string; text?: string };
      return record.type === 'text' ? (record.text ?? '') : JSON.stringify(part);
    })
    .join('\n');
}

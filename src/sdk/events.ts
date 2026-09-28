export type PermissionDecision =
  | { allow: true; remember: boolean }
  | { allow: false; reason: string };

export type KilnEvent =
  | { kind: 'turn.start'; turnId: string; promptUuid: string }
  | { kind: 'text'; turnId: string; delta: string }
  | { kind: 'thinking'; turnId: string; delta: string }
  | {
      kind: 'tool.start';
      turnId: string;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: 'tool.result';
      turnId: string;
      toolUseId: string;
      isError: boolean;
      output: string;
    }
  | {
      kind: 'permission.request';
      turnId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: 'turn.end';
      turnId: string;
      promptUuid: string;
      costUsd: number;
      isError: boolean;
      stopReason: string | null;
      result: string;
    }
  | { kind: 'session.ready'; sessionId: string }
  | { kind: 'fatal'; message: string };

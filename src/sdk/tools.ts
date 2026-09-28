import { z } from 'zod';
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

// The SDK types tool handlers against AnyZodRawShape, which erases the argument
// type. Re-introduce inference here so each handler gets real parameter types.
function tool<S extends z.ZodRawShape>(definition: {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}): SdkMcpToolDefinition<any> {
  return definition as unknown as SdkMcpToolDefinition<any>;
}

export type ConsoleReport = {
  errors: Array<{ level: string; text: string; source?: string }>;
  networkFailures: Array<{ url: string; status: number; error: string }>;
  pageErrors: string[];
};

export type PreviewState = {
  running: boolean;
  url: string | null;
  framework: string | null;
};

export type ElementReport = {
  selector: string;
  tag: string;
  attributes: Record<string, string>;
  outerHTML: string;
  accessibleName: string | null;
  rect: { x: number; y: number; width: number; height: number };
  sourceHint: string | null;
};

export interface KilnDeps {
  preview(): PreviewState;
  captureScreenshot(): Promise<{ base64: string; mimeType: string }>;
  readConsole(): Promise<ConsoleReport>;
  inspectElement(selector: string): Promise<ElementReport | null>;
  askUser(question: string, choices: string[]): Promise<string>;
}

export function createKilnServer(deps: KilnDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'kiln',
    instructions:
      'Kiln owns the live preview for this project. Use preview_screenshot to see what the user sees, ' +
      'preview_console for errors, and inspect_element when the user points at something on screen. ' +
      'Use ask_user when a decision is genuinely the user\'s to make.',
    tools: [
      tool({
        name: 'preview_state',
        description: 'Report whether the dev server is running and where the preview is served.',
        inputSchema: {},
        handler: async () => text(JSON.stringify(deps.preview(), null, 2)),
      }),
      tool({
        name: 'preview_screenshot',
        description:
          'Capture the current preview viewport as an image. Use this to check your own work before ' +
          'reporting done, and whenever the user describes something visual.',
        inputSchema: {},
        handler: async () => {
          const shot = await deps.captureScreenshot();
          return {
            content: [
              { type: 'image', data: shot.base64, mimeType: shot.mimeType },
              { type: 'text', text: 'Current preview viewport.' },
            ],
          };
        },
      }),
      tool({
        name: 'preview_console',
        description:
          'Read console errors, uncaught page errors, and failed network requests since the last turn.',
        inputSchema: {},
        handler: async () => {
          const report = await deps.readConsole();
          if (!report.errors.length && !report.networkFailures.length && !report.pageErrors.length) {
            return text('No console errors, page errors, or failed requests.');
          }
          return text(JSON.stringify(report, null, 2));
        },
      }),
      tool({
        name: 'inspect_element',
        description:
          'Inspect the element the user selected in the preview. Returns its outer HTML, attributes, ' +
          'accessible name, and on-screen position. Use it before editing UI the user referred to.',
        inputSchema: { selector: z.string().describe('CSS selector or kiln element ref for the selection') },
        handler: async ({ selector }) => {
          const report = await deps.inspectElement(selector);
          if (!report) return text(`No element matched ${selector}.`);
          return text(JSON.stringify(report, null, 2));
        },
      }),
      tool({
        name: 'ask_user',
        description:
          'Ask the user a question and wait for their answer. Use sparingly and only when the choice is ' +
          'theirs to make; prefer deciding yourself when the codebase makes the answer obvious.',
        inputSchema: {
          question: z.string().describe('The question to put to the user'),
          choices: z.array(z.string()).describe('Suggested answers, if any'),
        },
        handler: async ({ question, choices }) => text(await deps.askUser(question, choices ?? [])),
      }),
    ],
  });
}

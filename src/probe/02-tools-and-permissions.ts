import { field, log, startProbe, verdict, withTempProject } from './harness.ts';
import type { KilnDeps } from '../sdk/tools.ts';
import type { PermissionRequest } from '../sdk/session.ts';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const asked: string[] = [];
const permissionCalls: PermissionRequest[] = [];

const deps: KilnDeps = {
  preview: () => ({ running: true, url: 'http://127.0.0.1:5173', framework: 'vite' }),
  captureScreenshot: async () => ({ base64: PNG_1X1, mimeType: 'image/png' }),
  readConsole: async () => ({ errors: [], networkFailures: [], pageErrors: [] }),
  inspectElement: async () => null,
  askUser: async (question) => {
    asked.push(question);
    return 'blue';
  },
};

await withTempProject(async (dir) => {
  const probe = startProbe(dir, {
    tools: deps,
    session: {
      permissionMode: 'default',
      // Kiln's own tools must be auto-allowed or the user is prompted for
      // every screenshot. Everything else is denied to prove interception.
      onPermission: async (request) => {
        permissionCalls.push(request);
        if (request.toolName.startsWith('mcp__kiln__')) return { allow: true, remember: false };
        return { allow: false, reason: 'Denied by probe policy.' };
      },
    },
  });

  const turn = await probe.send(
    [
      'Do exactly these two things, in order, then stop:',
      '1. Call the preview_state tool and tell me its framework value.',
      '2. Call the ask_user tool with question "Pick a colour" and choices ["red", "blue"],',
      '   then tell me which colour came back.',
    ].join(' '),
  );

  field('text', JSON.stringify(turn.text).slice(0, 400));
  field('tools', turn.tools);
  field('asked', asked);
  field('permission calls', permissionCalls.map((c) => `${c.toolName} (canRemember=${c.canRemember})`));
  field('cost', `$${turn.costUsd.toFixed(6)}`);

  const usedPreview = turn.tools.includes('mcp__kiln__preview_state');
  const usedAsk = turn.tools.includes('mcp__kiln__ask_user');
  const gotAnswer = asked[0] === 'Pick a colour';
  const answeredWithChoice = /\bblue\b/i.test(turn.text);
  const frameworkSeen = /vite/i.test(turn.text);
  const permissionCarriesMetadata = permissionCalls.every((c) => c.toolName.length > 0 && c.requestId.length > 0);

  log('');
  field('preview_state called', usedPreview);
  field('framework value reached model', frameworkSeen);
  field('ask_user called', usedAsk);
  field('ask_user answered', gotAnswer);
  field('answer reached model', answeredWithChoice);
  field('permission metadata', permissionCarriesMetadata);

  const ok = usedPreview && frameworkSeen && usedAsk && gotAnswer && answeredWithChoice && permissionCarriesMetadata;
  verdict(ok, 'm0.2 in-process MCP tools + m0.3 host-owned permission gate + ask_user');

  await probe.session.close();
  process.exit(ok ? 0 : 1);
});

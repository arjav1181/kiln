import { query } from '@anthropic-ai/claude-agent-sdk';
const candidates = [undefined, 'sonnet', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'];
for (const model of candidates) {
  const label = model ?? '(default)';
  try {
    const q = query({ prompt: 'Reply with exactly: PONG', options: { cwd: '/tmp', ...(model ? { model } : {}) } });
    for await (const m of q) {
      if (m.type === 'result') {
        const r = (m as any).result as string;
        const bad = r.startsWith('API Error');
        console.log(`${bad ? 'NO ' : 'YES'}  ${label.padEnd(24)} ${bad ? r.slice(0, 90) : `cost=$${(m as any).total_cost_usd}`}`);
        break;
      }
    }
  } catch (e) { console.log(`ERR  ${label.padEnd(24)} ${(e as Error).message.slice(0, 90)}`); }
}

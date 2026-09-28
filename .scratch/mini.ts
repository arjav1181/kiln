import { query } from '@anthropic-ai/claude-agent-sdk';
const q = query({ prompt: 'Reply with exactly: PONG', options: { cwd: '/tmp', model: 'haiku', includePartialMessages: true } });
const timer = setTimeout(() => { console.log('TIMEOUT after 60s, no messages'); process.exit(3); }, 60_000);
try {
  for await (const m of q) {
    if (m.type === 'system') console.log('system:', m.subtype, 'apiKeySource=', (m as any).apiKeySource);
    if (m.type === 'assistant') console.log('assistant text:', JSON.stringify((m as any).message?.content?.[0]?.text ?? '').slice(0,120));
    if (m.type === 'result') { console.log('result:', (m as any).subtype, JSON.stringify((m as any).result).slice(0,120), 'cost=', (m as any).total_cost_usd); clearTimeout(timer); break; }
  }
  clearTimeout(timer);
} catch (e) { clearTimeout(timer); console.log('THREW:', (e as Error).message.slice(0, 300)); }

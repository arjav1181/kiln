import { Session } from '../src/sdk/session.ts';
const s = Session.open({ cwd: '/tmp', includePartialMessages: true });
const t = setTimeout(() => { console.log('\nTIMEOUT'); process.exit(3); }, 90_000);
const uuid = await s.send('Reply with exactly: PONG');
console.log('sent uuid=', uuid, 'sessionId(pre)=', JSON.stringify(s.sessionId));
for await (const e of s.events) {
  if (e.kind === 'text') { process.stdout.write(e.delta); continue; }
  console.log('\nEVENT', e.kind, JSON.stringify(e).slice(0, 160));
  if (e.kind === 'turn.end' || e.kind === 'fatal') break;
}
clearTimeout(t);
console.log('\nDONE sessionId=', s.sessionId);
await s.close();

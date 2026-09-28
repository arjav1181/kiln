import { field, log, startProbe, verdict, withTempProject } from './harness.ts';

await withTempProject(async (dir) => {
  const probe = startProbe(dir);
  const started = Date.now();
  const turn = await probe.send('Reply with exactly the word KILN_OK and nothing else.');

  field('elapsed', `${Date.now() - started}ms`);
  field('session', probe.session.sessionId);
  field('promptUuid', turn.promptUuid);
  field('text', JSON.stringify(turn.text));
  field('isError', turn.isError);
  field('cost', `$${turn.costUsd.toFixed(6)}`);
  field('tools', turn.tools.length ? turn.tools : '(none)');

  const ok =
    turn.text.includes('KILN_OK') &&
    !turn.isError &&
    turn.promptUuid.length === 36 &&
    !turn.result.startsWith('API Error');
  verdict(ok, 'm0.1 bidirectional session + normalized events');

  await probe.session.close();
  process.exit(ok ? 0 : 1);
});

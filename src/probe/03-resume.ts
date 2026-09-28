import { readdir, readFile } from 'node:fs/promises';
import { field, log, startProbe, verdict, withTempProject } from './harness.ts';

const readIfPresent = (path: string) => readFile(path, 'utf8').catch(() => '(missing)');
const listTxt = async (dir: string) => (await readdir(dir)).filter((f) => f.endsWith('.txt')).sort();

const allowAll = { allow: true as const, remember: false };

await withTempProject(async (dir) => {
  const first = startProbe(dir, { session: { onPermission: async () => allowAll } });

  const t1 = await first.send('Create a file named one.txt containing the single word ONE. Reply with just OK.');
  field('turn 1', t1.text.trim().slice(0, 60));

  const t2 = await first.send('Create a file named two.txt containing the single word TWO. Reply with just OK.');
  field('turn 2', t2.text.trim().slice(0, 60));

  await first.session.close();

  const before = await listTxt(dir);
  field('files on disk', before);
  field('one.txt', (await readIfPresent(`${dir}/one.txt`)).trim());
  field('two.txt', (await readIfPresent(`${dir}/two.txt`)).trim());

  const resumed = startProbe(dir, {
    session: {
      resume: first.session.sessionId,
      resumeSessionAt: t1.promptUuid,
      onPermission: async () => allowAll,
    },
  });

  const t3 = await resumed.send(
    'Do not create or edit anything. Answer on two lines: ' +
      'A) the filename the user most recently asked you to create before this message. ' +
      'B) the .txt files currently in this directory.',
  );

  field('turn 3 (resumed)', t3.text.trim().slice(0, 300));
  const after = await listTxt(dir);
  field('files after resume', after);

  const conversationForked = /one\.txt/i.test(t3.text) && !/most recent\w*\s*[:=]?\s*two\.txt/i.test(t3.text);
  const filesRolledBack = JSON.stringify(after) !== JSON.stringify(before);
  const sawTwo = /two\.txt/.test(t3.text);

  log('');
  field('conversation forked', conversationForked);
  field('model still sees two.txt', sawTwo);
  field('files rolled back by SDK', filesRolledBack);
  field('cost', `$${resumed.costUsd.toFixed(6)}`);

  verdict(conversationForked, 'm0.5 GATE resumeSessionAt forks the conversation');
  log(
    filesRolledBack
      ? 'NOTE: SDK reverted files too. Git may be unnecessary for rollback.'
      : 'NOTE: SDK left files untouched. File rollback is ours, via git.',
  );

  await resumed.session.close();
  process.exit(conversationForked ? 0 : 1);
});

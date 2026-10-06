import { writeFile } from 'node:fs/promises';
import { launchBrowser } from '/home/runner/workspace/live-site/src/capture/browser.ts';

const base = process.argv[2]!;
const browser = await launchBrowser();

await browser.goto(`${base}/`);
await new Promise((r) => setTimeout(r, 1200));

const before = await browser.evaluate<string>('document.body.innerText.replace(/\\n{2,}/g, " | ").slice(0, 300)');
await writeFile('/tmp/opencode/pub-1-idle.png', Buffer.from(await browser.screenshot(), 'base64'));

// Type into the composer exactly as a user would, then send.
await browser.evaluate(`(() => {
  const box = document.querySelector('textarea');
  box.focus();
  return true;
})()`);

await browser.evaluate(`(() => {
  const box = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(box, 'Change the heading text to Hello from npx');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return box.value;
})()`);

const typed = await browser.evaluate<string>('document.querySelector("textarea").value');
console.log('typed:', JSON.stringify(typed));

await browser.evaluate(`(() => {
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send')?.click();
  return true;
})()`);

// Wait for the turn to produce output rather than sleeping blindly.
const deadline = Date.now() + 300_000;
let last = '';
for (;;) {
  const text = await browser.evaluate<string>('document.querySelector(".pane.chat .scroll")?.innerText ?? ""');
  if (text.includes('Hello from npx') && text.length > last.length) last = text;
  if (text.includes('Hello from npx') || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 2000));
}

await new Promise((r) => setTimeout(r, 2000));
await writeFile('/tmp/opencode/pub-2-turn.png', Buffer.from(await browser.screenshot(), 'base64'));

const chat = await browser.evaluate<string>('document.querySelector(".pane.chat .scroll")?.innerText ?? ""');
const previewText = await browser.evaluate<string>(`
  (() => {
    const f = document.querySelector('iframe');
    return f ? f.getAttribute('src') : null;
  })()
`);

console.log('--- chat ---');
console.log(chat.replace(/\n{2,}/g, '\n').slice(0, 700));
console.log('--- preview src ---', previewText);
console.log('before:', before);

await browser.close();

import type { Browser } from './browser.ts';

export type ElementReport = {
  selector: string;
  tag: string;
  attributes: Record<string, string>;
  outerHTML: string;
  accessibleName: string | null;
  rect: { x: number; y: number; width: number; height: number };
  domPath: string;
};

const INSPECT = `
(() => {
  const el = document.querySelector(SEL);
  if (!el) return null;
  const name = el.getAttribute('aria-label')
    || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent)
    || el.textContent?.trim()
    || el.getAttribute('title')
    || null;
  const r = el.getBoundingClientRect();
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
  }
  const attributes = {};
  for (const a of el.attributes) attributes[a.name] = a.value;
  return {
    selector: $(sel),
    tag: el.tagName.toLowerCase(),
    attributes,
    outerHTML: el.outerHTML.slice(0, 600),
    accessibleName: name,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    domPath: parts.join(' > '),
  };
})()
`;

/**
 * T0: everything a click yields and nothing more. The agent locates the source
 * from this, which is why it works on any stack.
 */
export async function inspectElement(page: Browser, selector: string): Promise<ElementReport | null> {
  const expression = INSPECT.replaceAll('SEL', JSON.stringify(selector)).replace('$(sel)', JSON.stringify(selector));
  return page.evaluate<ElementReport | null>(expression);
}

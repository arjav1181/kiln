/**
 * The script injected into every HTML response by the preview proxy.
 *
 * It is deliberately dependency-free and self-contained: it runs on any stack
 * because the only assumption is that the page has a DOM. Selection is
 * Alt-click so the preview stays usable for interacting with the app itself.
 */
export const INJECTED_CLIENT = String.raw`
(() => {
  if (window.__kiln) return;
  const origin = __KILN_ORIGIN__;
  const state = (window.__kiln = { origin, ready: true, at: Date.now() });
  document.documentElement.dataset.kiln = '1';

  let overlay = null;
  let current = null;

  const selectorFor = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  const ensureOverlay = () => {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      'border:2px solid #7c9cff', 'border-radius:3px',
      'box-shadow:0 0 0 9999px rgba(0,0,0,.28)', 'display:none',
      'transition:all 40ms linear',
    ].join(';');
    document.body.appendChild(overlay);
    return overlay;
  };

  const place = (el) => {
    const box = ensureOverlay();
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left - 2 + 'px';
    box.style.top = r.top - 2 + 'px';
    box.style.width = Math.max(r.width, 2) + 'px';
    box.style.height = Math.max(r.height, 2) + 'px';
    const label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    box.dataset.label = label;
    box.setAttribute('data-label', label);
  };

  const clear = () => {
    current = null;
    if (overlay) overlay.style.display = 'none';
  };

  document.addEventListener(
    'mousemove',
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return clear();
      current = el;
      place(el);
    },
    { passive: true, capture: true },
  );

  document.addEventListener('mouseleave', clear, { passive: true });

  document.addEventListener(
    'click',
    (event) => {
      if (!event.altKey) return;
      const el = event.target;
      if (!el || el.nodeType !== 1) return;
      event.preventDefault();
      event.stopPropagation();

      const payload = {
        type: 'kiln:select',
        selector: selectorFor(el),
        kilnId: el.getAttribute('data-kiln-id') || null,
        tag: el.tagName.toLowerCase(),
        outerHTML: el.outerHTML.slice(0, 600),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
      };

      try { parent.postMessage(payload, '*'); } catch {}
      try { navigator.clipboard?.writeText(payload.outerHTML).catch(() => {}); } catch {}
      clear();
    },
    { capture: true },
  );

  window.addEventListener('error', (event) => {
    fetch(origin + '/__kiln/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ level: 'pageerror', text: String(event.message) }),
    }).catch(() => {});
  });

  const originalError = console.error;
  console.error = function (...args) {
    try {
      fetch(origin + '/__kiln/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ level: 'error', text: args.map(String).join(' ') }),
      }).catch(() => {});
    } catch {}
    return originalError.apply(console, args);
  };

  console.debug('[kiln] client injected', state.origin);
})();
`;

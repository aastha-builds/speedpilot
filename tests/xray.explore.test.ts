import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { launchBrowser, releaseBrowser } from '@speedpilot/core';
import { captureUrl, classify } from '@speedpilot/xray';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A page full of trap buttons: every click is reported back to the server.
const PAGE = `<!doctype html><html><head><title>Traps</title></head><body>
<button class="menu-toggle" aria-expanded="false" aria-controls="m">Menu</button><nav id="m" hidden><a href="#a">A</a></nav>
<details><summary>Shipping</summary><p>x</p></details>
<div role="tablist"><button role="tab" aria-selected="true">Tab 1</button><button role="tab">Tab 2</button></div>
<button class="swiper-button-next" aria-label="Next slide">›</button>
<button id="delete">Delete my account</button>
<a id="logout" href="/logout">Log out</a>
<button id="buy">Buy now</button>
<button id="pay">Pay</button>
<button id="subscribe">Subscribe to newsletter</button>
<form action="/contact" method="post"><input name="email"><button id="submit">Send</button><button id="plain" type="button">Help</button></form>
<button id="add" class="add_to_cart_button">Add to cart</button>
<script>
document.addEventListener('click', function (e) {
  var t = e.target.closest('button, a, summary');
  if (t) navigator.sendBeacon('/clicked?el=' + encodeURIComponent(t.id || t.className || t.textContent.trim()));
  if (t && t.tagName === 'A' && t.id === 'logout') e.preventDefault();
}, true);
document.querySelector('.menu-toggle').addEventListener('click', function(){ document.getElementById('m').hidden = !document.getElementById('m').hidden; });
</script></body></html>`;

let server: Server;
let base = '';
const clicks: string[] = [];
const posts: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/clicked')) clicks.push(decodeURIComponent(req.url.split('el=')[1] ?? ''));
    if (req.method === 'POST') posts.push(req.url ?? '');
    if (req.url === '/' || req.url === '/index.html') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    else res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('X-ray exploration safe list', () => {
  it('in production mode never clicks anything outside the safe list', async () => {
    const browser = await launchBrowser();
    try {
      const cap = await captureUrl(browser, { url: base + '/', device: 'desktop', stage: 'production', outDir: mkdtempSync(join(tmpdir(), 'sp-trap-')), ownerCtx: { siteOrigin: base, platform: 'wordpress' }, explore: true });
      const ran = cap.exploration.filter((s) => s.ran).map((s) => s.label);
      expect(ran).toEqual(expect.arrayContaining(['Menu', 'Shipping', 'Tab 2']));
      expect(cap.exploration.some((s) => s.ran && s.kind === 'carousel')).toBe(true);
      for (const trap of ['delete', 'logout', 'buy', 'pay', 'subscribe', 'submit', 'plain', 'add']) expect(clicks.some((c) => c === trap), `clicked ${trap}`).toBe(false);
      expect(posts).toEqual([]);
      const refused = cap.exploration.filter((s) => !s.allowed).map((s) => s.label);
      expect(refused).toEqual(expect.arrayContaining(['Delete my account', 'Log out', 'Buy now', 'Pay', 'Subscribe to newsletter', 'Send']));
    } finally {
      await releaseBrowser();
    }
  });
  it('classifies candidates by stage', () => {
    const base = { index: 0, selector: '#x', tag: 'button', role: null, label: 'Delete', kind: 'button' as const, insideForm: false, isSubmit: false, href: null };
    expect(classify(base, 'production').allowed).toBe(false);
    expect(classify({ ...base, label: 'Menu', kind: 'menu-toggle' }, 'production').allowed).toBe(true);
    expect(classify({ ...base, label: 'Help', kind: 'button' }, 'production').allowed).toBe(false);
    expect(classify({ ...base, label: 'Help', kind: 'button' }, 'staging').allowed).toBe(true);
    expect(classify({ ...base, label: 'Log out', tag: 'a', href: '/logout', kind: 'link' }, 'staging').allowed).toBe(false);
  });
});

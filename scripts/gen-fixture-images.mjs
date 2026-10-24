// Generates the fixture images (large hero, oversized thumbs) with Chromium canvas. Deterministic.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const targets = [
  'fixtures/wp/theme/speedpilot-fixture/assets/img',
  'fixtures/shopify/theme/assets',
];

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(w, h, seed, quality) {
  const dataUrl = await page.evaluate(({ w, h, seed, quality }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${seed % 360},60%,45%)`);
    grad.addColorStop(1, `hsl(${(seed * 7) % 360},70%,30%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `hsla(${rnd() * 360},70%,${30 + rnd() * 50}%,0.35)`;
      g.beginPath(); g.arc(rnd() * w, rnd() * h, 2 + rnd() * 40, 0, 7); g.fill();
    }
    return c.toDataURL('image/jpeg', quality);
  }, { w, h, seed, quality });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}
const hero = await render(2400, 1200, 42, 0.95);
const thumbs = [];
for (let i = 1; i <= 6; i++) thumbs.push(await render(1200, 800, 100 + i, 0.92));
const banner = await render(1600, 200, 7, 0.9);
for (const t of targets) {
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'hero.jpg'), hero);
  thumbs.forEach((b, i) => writeFileSync(join(t, `thumb-${i + 1}.jpg`), b));
  writeFileSync(join(t, 'banner.jpg'), banner);
}
await browser.close();
console.log(`hero ${hero.length} bytes, thumb ${thumbs[0].length} bytes`);

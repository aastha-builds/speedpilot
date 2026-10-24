/**
 * Resized WebP copies of a theme image for srcset (IMG-03), drawn with the pinned Chromium's canvas so SpeedPilot needs
 * no native image library. The original file stays as it is.
 */
import { chromium } from 'playwright';

export async function resizeImage(data: Buffer, mime: string, widths: number[], quality = 0.8): Promise<Array<{ width: number; height: number; data: Buffer }>> {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const out = await page.evaluate(
      async ({ b64, mime, widths, quality }) => {
        const img = new Image();
        img.src = `data:${mime};base64,${b64}`;
        await img.decode();
        const res: Array<{ width: number; height: number; b64: string }> = [];
        for (const w of widths.filter((x) => x < img.naturalWidth)) {
          const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d')!.drawImage(img, 0, 0, w, h);
          res.push({ width: w, height: h, b64: c.toDataURL('image/webp', quality).split(',')[1]! });
        }
        return { res, natural: [img.naturalWidth, img.naturalHeight] };
      },
      { b64: data.toString('base64'), mime, widths, quality },
    );
    return out.res.map((r) => ({ width: r.width, height: r.height, data: Buffer.from(r.b64, 'base64') }));
  } finally {
    await browser.close();
  }
}

/** Natural size of an image file (JPEG, PNG, WebP or GIF) from its header. */
export function imageSize(b: Buffer): { width: number; height: number } | undefined {
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const n = b.readUInt32LE(21);
      return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
    }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const MAGIC = Buffer.from('SPBK1');

export function backupKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const k = env.SPEEDPILOT_BACKUP_KEY;
  if (!k) return undefined;
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('SPEEDPILOT_BACKUP_KEY must be 32 bytes, base64-encoded.');
  return buf;
}

/** Encrypts a file at rest with AES-256-GCM, streamed (SPEC.md 12). Output: MAGIC | iv(12) | ciphertext | tag(16). */
export function encryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, iv]));
  return new Promise((resolve, reject) => {
    const input = createReadStream(src);
    input.on('error', reject);
    out.on('error', reject);
    cipher.on('data', (d: Buffer) => out.write(d));
    cipher.on('end', () => out.end(cipher.getAuthTag(), () => resolve()));
    input.pipe(cipher);
  });
}

/** Streamed decryption of encryptFile output. */
export function decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const size = statSync(src).size;
  const fd = openSync(src, 'r');
  const head = Buffer.alloc(MAGIC.length + 12);
  readSync(fd, head, 0, head.length, 0);
  const tag = Buffer.alloc(16);
  readSync(fd, tag, 0, 16, size - 16);
  closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return Promise.reject(new Error(`${src} is not a SpeedPilot encrypted backup`));
  const d = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  return pipeline(createReadStream(src, { start: head.length, end: size - 17 }), d, createWriteStream(dest));
}

/** Simpler, synchronous encryption for files that fit in memory (database dumps of small sites, manifests). */
export function encryptFileSync(src: string, dest: string, key: Buffer): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(readFileSync(src)), cipher.final()]);
  writeFileSync(dest, Buffer.concat([MAGIC, iv, ct, cipher.getAuthTag()]));
}

export function decryptFileSync(src: string, dest: string, key: Buffer): void {
  const buf = readFileSync(src);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${src} is not a SpeedPilot encrypted backup`);
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(MAGIC.length + 12, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  writeFileSync(dest, Buffer.concat([d.update(ct), d.final()]));
}

export function isEncrypted(path: string): boolean {
  if (statSync(path).size < MAGIC.length) return false;
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(MAGIC.length);
  readSync(fd, b, 0, MAGIC.length, 0);
  closeSync(fd);
  return b.equals(MAGIC);
}

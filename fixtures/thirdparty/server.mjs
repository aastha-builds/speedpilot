// Fixture "third-party CDN" on a second origin (default http://127.0.0.1:8890). Local only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const types = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

export function startThirdParty(port = Number(process.env.SPF_THIRDPARTY_PORT ?? 8890), host = '127.0.0.1') {
  const hits = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    hits.push({ method: req.method, path: url.pathname, query: url.search });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/g/collect' || url.pathname === '/chat/ping') {
      res.writeHead(204).end();
      return;
    }
    try {
      const file = join(dir, url.pathname.replace(/\.\./g, ''));
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=300' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, hits, url: `http://${host}:${port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startThirdParty().then(({ url }) => console.log(`third-party fixture on ${url}`));
}

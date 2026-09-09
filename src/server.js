import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { syncAll } from './sync.js';
import { handleApiRequest } from './api-router.js';

const publicDir = path.resolve('public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      return sendWebResponse(response, await handleApiRequest(toWebRequest(request, url)));
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(publicDir)) return json(response, 403, { error: 'Forbidden' });
    const content = await fs.readFile(file); response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); response.end(content);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : error.status || 500;
    json(response, status, { error: status === 500 ? 'Request failed' : error.message, detail: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
function toWebRequest(request, url) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(url, init);
}
async function sendWebResponse(response, webResponse) {
  response.statusCode = webResponse.status;
  for (const [name, value] of webResponse.headers) response.setHeader(name, value);
  response.end(webResponse.body ? Buffer.from(await webResponse.arrayBuffer()) : undefined);
}

server.listen(config.port, '127.0.0.1', () => console.log(`Fantasy League Analytics running at http://localhost:${config.port} (read-only, local computer only)`));
const refreshTimer = setInterval(() => syncAll().catch((error) => console.error(`Automatic read-only refresh failed: ${error.message}`)), config.cacheTtlMs);
refreshTimer.unref();

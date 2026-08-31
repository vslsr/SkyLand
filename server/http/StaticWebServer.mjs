import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { sendText } from './HttpResponses.mjs';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

async function getFileStat(pathname) {
  try {
    return await stat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export class StaticWebServer {
  constructor(rootDirectory) {
    this.rootDirectory = resolve(rootDirectory);
    this.indexPath = resolve(this.rootDirectory, 'index.html');
  }

  async isReady() {
    return Boolean(await getFileStat(this.indexPath));
  }

  async handle(request, response, url) {
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) return false;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed', request.method, { Allow: 'GET, HEAD' });
      return true;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      sendText(response, 400, 'Bad Request', request.method);
      return true;
    }

    const requestedPath = resolve(this.rootDirectory, decodedPath.replace(/^[/\\]+/, ''));
    const relativePath = relative(this.rootDirectory, requestedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      sendText(response, 403, 'Forbidden', request.method);
      return true;
    }

    const indexStat = await getFileStat(this.indexPath);
    if (!indexStat?.isFile()) {
      sendText(
        response,
        503,
        'Web client build not found. Run "npm run build" before starting the combined server.',
        request.method,
      );
      return true;
    }

    let filePath = requestedPath;
    let fileStat = await getFileStat(filePath);
    if (fileStat?.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStat = await getFileStat(filePath);
    }

    // Vite 客户端路由没有扩展名时回退到 index.html；静态资源缺失则保持 404。
    if (!fileStat?.isFile() && extname(decodedPath) === '') {
      filePath = this.indexPath;
      fileStat = indexStat;
    }

    if (!fileStat?.isFile()) {
      sendText(response, 404, 'Not Found', request.method);
      return true;
    }

    const extension = extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
    const servedRelativePath = relative(this.rootDirectory, filePath).replaceAll('\\', '/');
    const cacheControl = extension === '.html'
      ? 'no-cache'
      : servedRelativePath.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';

    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStat.size,
      'Last-Modified': fileStat.mtime.toUTCString(),
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    });

    if (request.method === 'HEAD') {
      response.end();
      return true;
    }

    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return true;
  }
}

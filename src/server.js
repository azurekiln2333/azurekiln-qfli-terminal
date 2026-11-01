import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { configuration, ExecutorError, limits, log, requestContext, validateFiles } from './config.js';
import { Sessions } from './sessions.js';

function response(res, status, value, close = false) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...(close ? { Connection: 'close' } : {}) });
  res.end(JSON.stringify(value));
}

function eventWriter(res, controller) {
  let bytes = 0, pending = Promise.resolve();
  const write = async value => {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) {
      throw new ExecutorError('execution_cancelled', 499);
    }
    const line = `${JSON.stringify(value)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > 2 * 1024 * 1024) throw new ExecutorError('output_limit', 413);
    if (res.write(line)) return;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        res.off('drain', drain);
        res.off('close', close);
        res.off('error', close);
        controller.signal.removeEventListener('abort', close);
        error ? reject(error) : resolve();
      };
      const drain = () => finish();
      const close = () => finish(new ExecutorError('execution_cancelled', 499));
      const timer = setTimeout(() => { controller.abort(); close(); }, 5000);
      res.once('drain', drain);
      res.once('close', close);
      res.once('error', close);
      controller.signal.addEventListener('abort', close, { once: true });
      if (controller.signal.aborted || res.destroyed) close();
    });
  };
  return value => {
    const operation = pending.then(() => write(value));
    pending = operation.catch(() => {});
    return operation;
  };
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json' ||
      req.headers['content-encoding'] ||
      (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) ||
        Number(req.headers['content-length']) > limits.bodyBytes))) {
    throw new ExecutorError('invalid_request_body', 400);
  }
  const chunks = await new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    const finish = (error) => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      req.removeListener('aborted', aborted);
      error ? reject(error) : resolve(parts);
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > limits.bodyBytes) {
        req.pause();
        finish(new ExecutorError('request_body_limit', 413));
        return;
      }
      parts.push(chunk);
    };
    const end = () => finish();
    const fail = () => finish(new ExecutorError('request_body_failed', 400));
    const aborted = () => finish(new ExecutorError('execution_cancelled', 499));
    const timer = setTimeout(() => {
      req.pause();
      finish(new ExecutorError('request_body_timeout', 408));
    }, 5000);
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    req.once('aborted', aborted);
    if (req.aborted || req.destroyed) aborted();
  });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ExecutorError('invalid_request_body', 400); }
}

let config;
try { config = configuration(); }
catch (error) { log('configuration_failed', { code: error.message }); process.exit(1); }
const secretHash = createHash('sha256').update(config.secret).digest();
// A container publishes one loopback port; Docker forwards to the container
// interface, so the container must bind the wildcard address. Bare-metal
// installs keep the loopback-only listener.
const listenHost = config.container ? '0.0.0.0' : '127.0.0.1';
const sessions = new Sessions(config);
let initializing = true;

async function handleRequest(req, res, requestId) {
  res.setHeader('X-Request-Id', requestId);
  const authorization = req.headers.authorization ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const authorized = timingSafeEqual(secretHash, createHash('sha256').update(supplied).digest());
  if (!supplied || !authorized) {
    response(res, 401, { error: 'executor_unauthorized', requestId }, true);
    return;
  }
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableFinished) controller.abort(); };
  req.on('aborted', disconnect);
  res.on('close', disconnect);
  if (req.aborted || res.destroyed) controller.abort();
  const started = Date.now();
  let stage = 'request', status = 200;
  let emit;
  try {
    if (req.method === 'GET' && req.url === '/health') {
      status = !initializing && sessions.ready ? 200 : 503;
      response(res, status, { ready: status === 200, capacity: sessions.capacity(), requestId });
      return;
    }
    if (!['/v1/exec', '/v1/exec/stream', '/v1/session'].includes(req.url) ||
        (req.url === '/v1/session' ? req.method !== 'DELETE' : req.method !== 'POST')) {
      throw new ExecutorError('not_found', 404);
    }
    if (initializing) throw new ExecutorError('terminal_unavailable');
    stage = 'decode';
    const value = await body(req);
    if (typeof value.userId !== 'string' || !/^user_[a-f0-9]{32}$/.test(value.userId)) {
      throw new ExecutorError('invalid_user_id', 400);
    }
    if (req.url === '/v1/session') {
      if (Object.keys(value).some(key => key !== 'userId')) throw new ExecutorError('invalid_request_body', 400);
      stage = 'reset';
      await sessions.reset(value.userId);
      response(res, 200, { ok: true, reset: true, requestId });
      return;
    }
    if (Object.keys(value).some(key => !['userId', 'command', 'files'].includes(key)) ||
        typeof value.command !== 'string' || !value.command.trim() ||
        value.command.length > 2000 || value.command.includes('\0')) {
      throw new ExecutorError('invalid_command', 400);
    }
    validateFiles(value.files);
    if (req.url === '/v1/exec/stream') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      emit = eventWriter(res, controller);
    }
    stage = 'execute';
    const result = await sessions.execute(value.userId, value.command, controller.signal,
      { files: value.files, ...(emit ? { emit } : {}) });
    if (emit) {
      await emit({ type: 'result', ...result });
      res.end();
    } else response(res, 200, result);
  } catch (error) {
    status = error instanceof ExecutorError ? error.status : 503;
    log('request_failed', { requestId, stage, status,
      code: error instanceof ExecutorError ? error.code : 'executor_failure' });
    const code = error instanceof ExecutorError ? error.code : 'terminal_unavailable';
    if (emit) {
      try { await emit({ type: 'error', message: code, status }); res.end(); }
      catch { controller.abort(); res.destroy(); }
    } else response(res, status, { error: code, requestId }, true);
  } finally {
    req.removeListener('aborted', disconnect);
    res.removeListener('close', disconnect);
    log('request_complete', { requestId, stage, status, durationMs: Date.now() - started });
  }
}

const server = http.createServer({ maxHeaderSize: 4096, connectionsCheckingInterval: 1000 }, (req, res) => {
  const requestId = /^[a-zA-Z0-9_-]{8,128}$/.test(req.headers['x-request-id'] ?? '')
    ? req.headers['x-request-id'] : randomUUID();
  return requestContext.run({ requestId }, () => handleRequest(req, res, requestId));
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 2000;
server.timeout = 90_000;
server.maxHeadersCount = 20;
server.maxConnections = 64;
server.on('timeout', socket => socket.destroy());
server.on('clientError', (_error, socket) => socket.destroy());

// Acquire the fixed local port before orphan reconciliation; another instance must
// never erase live containers managed by the first process.
server.on('error', error => {
  log('listener_failed', { code: error.code ?? 'listener_failure' });
  process.exitCode = 1;
});
server.listen(3101, listenHost, async () => {
  try {
    await sessions.initialize();
    initializing = false;
    log('executor_ready', { address: `${listenHost}:3101` });
  } catch (error) {
    log('initialization_failed', { code: error.code ?? 'executor_failure' });
    server.close();
    const cleaned = await sessions.shutdown();
    process.exitCode = 1;
    log('shutdown_complete', { cleaned });
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  initializing = true;
  log('shutdown_started', { signal });
  server.close();
  server.closeIdleConnections();
  const cleaned = await sessions.shutdown();
  server.closeAllConnections();
  process.exitCode = cleaned ? 0 : 1;
  log('shutdown_complete', { cleaned });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', () => {
  log('uncaught_failure');
  shutdown('uncaughtException').then(() => { process.exitCode = 1; });
});
process.on('unhandledRejection', () => {
  log('unhandled_failure');
  shutdown('unhandledRejection').then(() => { process.exitCode = 1; });
});

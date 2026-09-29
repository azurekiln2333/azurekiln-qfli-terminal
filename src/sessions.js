import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Docker } from './docker.js';
import { ExecutorError, limits, log } from './config.js';

const owner = 'io.qfli.terminal.owner=qfli-terminal-v1';

export class Sessions {
  constructor(config) {
    this.docker = new Docker(config);
    this.config = config;
    this.pendingDir = path.join(config.runtimeDir, 'qfli-terminal-pending');
    this.records = new Map();
    this.running = 0;
    this.queue = [];
    this.users = new Map();
    this.slotWaiters = [];
    this.engineReady = false;
    this.stopping = false;
    this.reconciling = false;
  }

  get ready() {
    return this.engineReady && !this.stopping &&
      ![...this.records.values()].some(record => record.deleting || record.uncertain);
  }

  async initialize() {
    this.imageId = await this.docker.validateEngine();
    if (this.stopping) throw new ExecutorError('executor_stopping');
    try { await mkdir(this.pendingDir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = await lstat(this.pendingDir);
    if (!state.isDirectory() || state.uid !== this.config.uid || (state.mode & 0o777) !== 0o700) {
      throw new ExecutorError('create_journal_invalid');
    }
    if ((await readdir(this.pendingDir)).length) throw new ExecutorError('create_recovery_required');
    await this.reconcile();
    if (this.stopping) throw new ExecutorError('executor_stopping');
    if (this.records.size) throw new ExecutorError('orphan_cleanup_pending');
    // Prove effective limits before accepting the first public command.
    const probe = this.reserve('startup-probe');
    probe.busy = true;
    this.running++;
    try { await this.create(probe); }
    finally {
      try { await this.destroy(probe); }
      finally { probe.busy = false; this.running--; this.wakeSlots(); }
    }
    if (this.stopping) throw new ExecutorError('executor_stopping');
    this.engineReady = true;
    this.timer = setInterval(() => this.reconcile().catch(error => {
      this.engineReady = false;
      this.drainQueue();
      log('reconcile_failed', { code: error.code ?? 'executor_failure' });
    }), 15_000);
  }

  reserve(key) {
    if (this.stopping) throw new ExecutorError('executor_stopping');
    const record = { key, name: `qfli-terminal-${randomUUID()}`, createdAt: Date.now(),
      lastUsedAt: Date.now(), busy: false, deleting: false, uncertain: false,
      controller: new AbortController() };
    this.records.set(key, record);
    return record;
  }

  ensureLive(record) {
    if (this.stopping || record.deleting || record.controller.signal.aborted) throw new ExecutorError('execution_cancelled', 499);
    if (Date.now() - record.createdAt >= limits.leaseMs) throw new ExecutorError('session_expired', 410);
  }

  async management(record, args) {
    this.ensureLive(record);
    const operation = this.docker.require(args);
    record.inflight = operation;
    try { return await operation; }
    finally { if (record.inflight === operation) record.inflight = undefined; }
  }

  async create(record) {
    this.ensureLive(record);
    const marker = path.join(this.pendingDir, record.name);
    try { await writeFile(marker, 'pending\n', { flag: 'wx', mode: 0o600 }); }
    catch { record.uncertain = true; throw new ExecutorError('create_journal_failed'); }
    let issued = false;
    try {
      this.ensureLive(record);
      issued = true;
      await this.management(record, ['create', '--name', record.name, '--rm', '--pull=never',
        '--label', owner, '--runtime', 'runsc', '--network', 'none', '--ipc', 'private',
        '--hostname', 'sandbox', '--read-only',
        '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes),
        '--cpus', '0.5', '--pids-limit', String(limits.pids), '--shm-size', '1m',
        '--ulimit', 'nofile=256:256', '--ulimit', 'core=0:0', '--ulimit', 'nproc=64:64',
        '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m,mode=0700,uid=65532,gid=65532',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777',
        '--workdir', '/workspace', '--env', 'HOME=/workspace', '--env', 'LANG=C.UTF-8',
        '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--log-driver', 'none', this.imageId]);
    } catch (error) {
      // A missing success response (including CLI EOF/nonzero exit) cannot prove
      // the daemon rejected create. Retain a restart-persistent recovery marker.
      if (issued) record.uncertain = true;
      if (!record.uncertain) {
        try { await unlink(marker); }
        catch { record.uncertain = true; }
      }
      throw error;
    }
    try { await unlink(marker); }
    catch { record.uncertain = true; throw new ExecutorError('create_journal_failed'); }
    await this.management(record, ['start', '--', record.name]);
    const readiness = await this.management(record, ['exec', '--user', '65532:65532', record.name,
      '/usr/bin/python3', '-I', '/usr/local/lib/qfli/ready.py']);
    if (readiness.trim() !== '{"ready":true}') throw new ExecutorError('sandbox_supervisor_not_ready');
    this.ensureLive(record);
    record.id = await this.docker.validateContainer(record.name, this.imageId);
    this.ensureLive(record);
  }

  async destroy(record, { slotHeld = false } = {}) {
    if (record.removal) return record.removal;
    record.deleting = true;
    record.controller.abort();
    const needsSlot = !slotHeld && !record.busy;
    record.removal = (async () => {
      // Wait until the current CLI closes; no following operation can pass ensureLive.
      if (record.inflight) await record.inflight.catch(() => {});
      if (needsSlot) {
        while (this.running >= limits.running) await new Promise(resolve => this.slotWaiters.push(resolve));
        this.running++;
      }
      try {
        await this.docker.remove(record.name);
        if (record.uncertain) throw new ExecutorError('daemon_restart_required');
        if (this.records.get(record.key) === record) this.records.delete(record.key);
      } catch (error) {
        log('cleanup_pending', { code: error.code ?? 'executor_failure' });
        throw new ExecutorError('container_cleanup_pending');
      } finally {
        record.removal = undefined;
        if (needsSlot) { this.running--; this.wakeSlots(); this.drainQueue(); }
      }
    })();
    return record.removal;
  }

  wakeSlots() {
    for (const resolve of this.slotWaiters.splice(0)) resolve();
  }

  cancelQueued(item, error) {
    const index = this.queue.indexOf(item);
    if (index === -1) return;
    this.queue.splice(index, 1);
    clearTimeout(item.timer);
    item.signal.removeEventListener('abort', item.abort);
    item.reject(error);
    this.updatePositions();
  }

  updatePositions() {
    for (const [index, item] of this.queue.entries()) {
      if (item.position === index + 1) continue;
      item.position = index + 1;
      const position = item.position;
      Promise.resolve().then(() => this.queue.includes(item) &&
        item.emit({ type: 'progress', stage: 'queued', position }))
        .catch(() => this.cancelQueued(item, new ExecutorError('execution_cancelled', 499)));
    }
  }

  drainQueue() {
    if (!this.ready) {
      for (const item of [...this.queue]) this.cancelQueued(item, new ExecutorError('terminal_unavailable'));
      return;
    }
    while (this.running < limits.running && this.queue.length) {
      const item = this.queue.shift();
      clearTimeout(item.timer);
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) item.reject(new ExecutorError('execution_cancelled', 499));
      else if (!this.records.has(item.userId) && this.records.size >= limits.sessions) {
        item.reject(new ExecutorError('session_capacity', 429));
      } else { this.running++; item.resolve(); }
    }
    this.updatePositions();
  }

  admit(userId, signal, emit) {
    if (signal.aborted) throw new ExecutorError('execution_cancelled', 499);
    if (!this.records.has(userId) && this.records.size >= limits.sessions) {
      throw new ExecutorError('session_capacity', 429);
    }
    if (this.running < limits.running && !this.queue.length) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= limits.waiting) throw new ExecutorError('queue_full', 429);
    return new Promise((resolve, reject) => {
      const item = { userId, signal, emit, resolve, reject, position: 0 };
      item.abort = () => this.cancelQueued(item, new ExecutorError('execution_cancelled', 499));
      item.timer = setTimeout(() => this.cancelQueued(item, new ExecutorError('queue_timeout', 408)), limits.queueMs);
      signal.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      this.updatePositions();
      if (signal.aborted) item.abort();
    });
  }

  async execute(userId, command, signal, { files, emit = async () => {} } = {}) {
    if (!this.ready) throw new ExecutorError('terminal_unavailable');
    const current = this.records.get(userId);
    if (this.users.has(userId) || current?.busy || current?.deleting) throw new ExecutorError('user_command_busy', 409);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.users.set(userId, controller);
    let admitted = false;
    try {
      await this.admit(userId, controller.signal, emit);
      admitted = true;
      if (!this.ready) throw new ExecutorError('terminal_unavailable');
      return await this.executeAdmitted(userId, command, controller.signal, files, emit);
    } finally {
      this.users.delete(userId);
      signal.removeEventListener('abort', abort);
      if (admitted) this.running--;
      this.wakeSlots();
      this.drainQueue();
    }
  }

  async executeAdmitted(userId, command, signal, files, emit) {
    if (signal.aborted) throw new ExecutorError('execution_cancelled', 499);
    let record = this.records.get(userId);
    if (record && (Date.now() - record.lastUsedAt >= limits.idleMs ||
        Date.now() - record.createdAt >= limits.leaseMs)) {
      // Mark expiry synchronously so a concurrent request cannot reuse this session.
      await this.destroy(record, { slotHeld: true });
      throw new ExecutorError('session_expired', 410);
    }
    const fresh = !record;
    if (fresh) {
      if (this.records.size >= limits.sessions) throw new ExecutorError('session_capacity', 429);
      record = this.reserve(userId);
    }
    // Reserve both capacities and user exclusivity before the first await.
    record.busy = true;
    const abort = () => record.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let deadline, cleaning = false;
    try {
      if (fresh) {
        await emit({ type: 'progress', stage: 'initializing' });
        await this.create(record);
      }
      this.ensureLive(record);
      await this.docker.validateContainer(record.name, this.imageId);
      this.ensureLive(record);
      await emit({ type: 'progress', stage: 'ready' });
      let cwd = '/workspace';
      if (files) {
        await emit({ type: 'progress', stage: 'uploading' });
        const upload = this.docker.run(['exec', '-i', '--user', '65532:65534', record.name,
          '/usr/bin/python3', '-I', '/usr/local/lib/qfli/snapshot.py'], {
          signal: record.controller.signal, timeoutMs: 5000, outputBytes: 1024,
          input: Buffer.from(JSON.stringify({ files })),
        });
        record.inflight = upload;
        let uploaded;
        try { uploaded = await upload; }
        catch (error) {
          if (error.code === 'docker_timeout') throw new ExecutorError('snapshot_upload_failed');
          throw error;
        }
        finally { if (record.inflight === upload) record.inflight = undefined; }
        let metadata;
        try { metadata = JSON.parse(uploaded.stdout); }
        catch { throw new ExecutorError('snapshot_upload_failed'); }
        if (uploaded.exitCode !== 0 || uploaded.stderr.trim() ||
            !/^\/workspace\/\.qfli-run-[a-f0-9]{32}$/.test(metadata?.cwd ?? '')) {
          throw new ExecutorError('snapshot_upload_failed');
        }
        cwd = metadata.cwd;
        this.ensureLive(record);
      }
      await emit({ type: 'progress', stage: 'running' });
      deadline = setTimeout(() => record.controller.abort(), limits.commandMs);
      const operation = this.docker.run(['exec', '--user', '65532:65532', '--workdir', cwd,
        '--env', 'HOME=/workspace', '--env', 'LANG=C.UTF-8', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
        record.name, '/bin/sh', '-c', command], {
        signal: record.controller.signal, timeoutMs: limits.commandMs, outputBytes: limits.outputBytes,
        onOutput: emit,
      });
      record.inflight = operation;
      let result;
      try { result = await operation; }
      finally {
        clearTimeout(deadline);
        deadline = undefined;
        if (record.inflight === operation) record.inflight = undefined;
      }
      this.ensureLive(record);
      if (result.exitCode === 137) throw new ExecutorError('sandbox_resource_terminated', 409);
      cleaning = true;
      await emit({ type: 'progress', stage: 'cleaning' });
      // A distinct GID prevents same-UID ptrace/proc-memory access before Python
      // disables dumpability. The shared UID still permits killing user processes.
      const cleanup = this.docker.run(['exec', '--user', '65532:65534', record.name,
        '/usr/bin/python3', '-I', '/usr/local/lib/qfli/cleanup.py'], {
        signal: record.controller.signal, timeoutMs: 3000, outputBytes: 1024,
      });
      record.inflight = cleanup;
      let cleaned;
      try { cleaned = await cleanup; }
      finally { if (record.inflight === cleanup) record.inflight = undefined; }
      if (cleaned.exitCode !== 0 || cleaned.stdout.trim() !== '{"quiescent":true}' || cleaned.stderr.trim()) {
        throw new ExecutorError('sandbox_not_quiescent');
      }
      this.ensureLive(record);
      await this.docker.validateContainer(record.name, this.imageId);
      this.ensureLive(record);
      record.lastUsedAt = Date.now();
      return { ...result, cwd: '/workspace' };
    } catch (error) {
      if (!cleaning && !signal.aborted) {
        await emit({ type: 'progress', stage: 'cleaning' }).catch(() => {});
      }
      await this.destroy(record);
      if (error.code === 'docker_timeout' ||
          (error.code === 'execution_cancelled' && !signal.aborted)) {
        throw new ExecutorError('command_timeout', 408);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      record.busy = false;
    }
  }

  async reset(userId) {
    this.users.get(userId)?.abort();
    const queued = this.queue.find(item => item.userId === userId);
    if (queued) this.cancelQueued(queued, new ExecutorError('execution_cancelled', 499));
    const record = this.records.get(userId);
    if (record) await this.destroy(record);
    this.drainQueue();
  }

  async reconcile() {
    if (this.reconciling || this.stopping) return;
    this.reconciling = true;
    try {
      const imageId = await this.docker.validateEngine();
      if (this.stopping) return;
      if (this.imageId && imageId !== this.imageId) throw new ExecutorError('sandbox_image_changed');
      const ids = await this.docker.owned();
      if (this.stopping) return;
      const known = new Set([...this.records.values()].map(record => record.id).filter(Boolean));
      // A currently creating record has a reserved name before its ID is known.
      const creationPending = [...this.records.values()].some(record => !record.id && !record.deleting);
      if (!creationPending) {
        for (const id of ids) {
          if (known.has(id)) continue;
          let record = this.records.get(`orphan:${id}`);
          if (!record) {
            record = this.reserve(`orphan:${id}`);
            record.name = id;
            record.id = id;
          }
        }
      }
      for (const record of [...this.records.values()]) {
        const expired = Date.now() - record.createdAt >= limits.leaseMs ||
          (!record.busy && Date.now() - record.lastUsedAt >= limits.idleMs);
        if (record.deleting || record.uncertain || record.key.startsWith('orphan:') || expired) {
          await this.destroy(record).catch(() => {});
        }
      }
      this.engineReady = true;
      this.drainQueue();
    } finally { this.reconciling = false; }
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.drainQueue();
    const results = await Promise.allSettled([...this.records.values()].map(record => this.destroy(record)));
    return results.every(result => result.status === 'fulfilled');
  }
}

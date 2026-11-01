import { spawn } from 'node:child_process';
import { readFile, lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ExecutorError, limits, log } from './config.js';
import { toolchainVersion, sandboxTmpfs } from './sandbox.js';

export function accountBudgetValid({ memory, swap, pids, cpu }) {
  const bounded = (value, max) => /^\d+$/.test(value.trim()) &&
    Number(value) > 0 && Number(value) <= max;
  const cpuParts = cpu.trim().split(/\s+/);
  return bounded(memory, limits.memoryBytes) && swap.trim() === '0' &&
    bounded(pids, limits.pids) && cpuParts.length === 2 &&
    bounded(cpuParts[0], Number.MAX_SAFE_INTEGER) &&
    bounded(cpuParts[1], Number.MAX_SAFE_INTEGER) &&
    Number(cpuParts[0]) <= Number(cpuParts[1]);
}

export async function readAccountLimits(base) {
  try {
    const [memory, swap, pids, cpu] = await Promise.all(
      ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']
        .map(file => readFile(path.join(base, file), 'utf8')));
    return { memory, swap, pids, cpu };
  } catch {
    // A freshly booted host can briefly lack the slice limit files. Report the
    // same fail-closed code as ineffective limits, never a raw errno.
    throw new ExecutorError('sandbox_resource_controls_missing');
  }
}

export class Docker {
  constructor(config) { this.config = config; }

  async run(args, { signal, timeoutMs = limits.managementMs, outputBytes = 256 * 1024,
    input, onOutput } = {}) {
    if (signal?.aborted) throw new ExecutorError('execution_cancelled', 499);
    if (input !== undefined && (!Buffer.isBuffer(input) || input.length > limits.bodyBytes)) {
      throw new ExecutorError('snapshot_limit', 413);
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('/usr/bin/docker', args, {
          env: this.config.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false,
        });
      } catch { reject(new ExecutorError('docker_spawn_failed')); return; }
      let stdout = [], stderr = [], bytes = 0, failure;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      let publishing = Promise.resolve(), pendingOutput = 0;
      const kill = (code, status = 503) => {
        failure ??= new ExecutorError(code, status);
        child.kill('SIGKILL');
        child.stdout.resume();
        child.stderr.resume();
      };
      const abort = () => kill('execution_cancelled', 499);
      const timer = setTimeout(() => kill('docker_timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const publish = (type, text) => {
        if (!onOutput || !text || failure) return;
        pendingOutput++;
        child.stdout.pause();
        child.stderr.pause();
        publishing = publishing.then(() => onOutput({ type, text })).then(() => {
          pendingOutput--;
          if (!pendingOutput && !failure) { child.stdout.resume(); child.stderr.resume(); }
        }).catch(error => kill(error instanceof ExecutorError ? error.code : 'execution_cancelled',
          error instanceof ExecutorError ? error.status : 499));
      };
      const collect = (target, type, chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > outputBytes) { kill('output_limit', 413); return; }
        target.push(chunk);
        publish(type, decoders[type].write(chunk));
      };
      child.stdout.on('data', chunk => collect(stdout, 'stdout', chunk));
      child.stderr.on('data', chunk => collect(stderr, 'stderr', chunk));
      child.stdout.on('end', () => publish('stdout', decoders.stdout.end()));
      child.stderr.on('end', () => publish('stderr', decoders.stderr.end()));
      if (input !== undefined) {
        child.stdin.on('error', () => kill('snapshot_upload_failed'));
        child.stdin.end(input);
      }
      child.on('error', () => { failure ??= new ExecutorError('docker_spawn_failed'); });
      child.on('close', async exitCode => {
        await publishing;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) {
          log('docker_failed', { operation: args[0], code: failure.code });
          reject(failure);
          return;
        }
        const output = { exitCode: exitCode ?? 255,
          stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > outputBytes) {
          log('docker_failed', { operation: args[0], code: 'output_limit' });
          reject(new ExecutorError('output_limit', 413));
          return;
        }
        resolve(output);
      });
    });
  }

  async require(args, options) {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      const detail = ['create', 'start'].includes(args[0]) ? result.stderr.trim().slice(0, 1024) : '';
      log('docker_failed', { operation: args[0], exitCode: result.exitCode,
        ...(detail ? { detail } : {}) });
      throw new ExecutorError('docker_operation_failed');
    }
    return result.stdout;
  }

  async json(args) {
    try { return JSON.parse(await this.require(args)); }
    catch (error) { if (error instanceof ExecutorError) throw error; throw new ExecutorError('docker_response_invalid'); }
  }

  async owned() {
    const output = await this.require(['ps', '-aq', '--no-trunc', '--filter', 'label=io.qfli.terminal.owner=qfli-terminal-v1']);
    const ids = output.trim() ? output.trim().split('\n') : [];
    if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new ExecutorError('docker_inventory_invalid');
    return ids;
  }

  async remove(name) {
    // A successful rm is insufficient: prove that this exact identifier disappeared.
    await this.run(['rm', '-f', '--', name]);
    const result = await this.run(['inspect', '--type', 'container', '--', name]);
    if (result.exitCode === 0) throw new ExecutorError('container_cleanup_pending');
    if (!/^Error(?: response from daemon)?: No such (?:object|container): /m.test(result.stderr.trim())) {
      throw new ExecutorError('container_cleanup_unconfirmed');
    }
  }

  async validateEngine() {
    const runtime = await lstat(this.config.runtimeDir);
    if (!runtime.isDirectory() || runtime.uid !== this.config.uid || (runtime.mode & 0o777) !== 0o700) {
      throw new ExecutorError('docker_runtime_directory_invalid');
    }
    const socket = await lstat(this.config.socket);
    if (!socket.isSocket() || socket.uid !== this.config.uid) throw new ExecutorError('docker_socket_invalid');
    const info = await this.json(['info', '--format', '{{json .}}']);
    if (info.OSType !== 'linux' || info.CgroupVersion !== '2' ||
        info.CgroupDriver !== 'systemd' ||
        !info.SecurityOptions?.some(item => item === 'name=rootless') ||
        !info.SecurityOptions?.includes('name=seccomp,profile=builtin') ||
        info.Runtimes?.runsc?.path !== '/usr/local/bin/runsc' ||
        JSON.stringify(info.Runtimes.runsc.runtimeArgs) !==
          JSON.stringify(['--network=none', '--ignore-cgroups'])) {
      throw new ExecutorError('docker_required_isolation_missing');
    }
    await this.validateAccountBudget();
    const images = await this.json(['image', 'inspect', '--', this.config.image]);
    const image = images[0];
    const expectedEntry = ['/usr/bin/python3', '-I', '/usr/local/lib/qfli/init.py'];
    if (images.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '') ||
        image.Config?.User !== '65533:65533' ||
        image.Config?.Labels?.['io.qfli.terminal.image'] !== '1' ||
        image.Config?.Labels?.['io.qfli.terminal.toolchains'] !== toolchainVersion ||
        Object.keys(image.Config?.Volumes ?? {}).length ||
        JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(expectedEntry) ||
        (image.Config?.Cmd?.length ?? 0) !== 0) throw new ExecutorError('sandbox_image_invalid');
    return image.Id;
  }

  async validateAccountBudget() {
    const root = this.config.cgroupRoot;
    // Host slice paths use the host account UID. In a rootless container the
    // process UID is 0 but the dedicated account still owns user-<hostUid>.slice.
    const base = `${root}/user.slice/user-${this.config.hostUid}.slice`;
    const [state, rootState, filesystem] = await Promise.all([lstat(base), lstat(root), statfs(root)]);
    // Host-service protection maps host root to the overflow UID. A rootless
    // container maps its own root to the runner UID, so host root must still
    // appear as overflow. Reject a container that runs as real host root.
    const rootOwnerInvalid = this.config.container
      ? rootState.uid !== 65534 || state.uid !== 65534
      : rootState.uid === this.config.uid;
    if (filesystem.type !== 0x63677270 || !rootState.isDirectory() || rootOwnerInvalid ||
        !state.isDirectory() || state.uid !== rootState.uid) {
      throw new ExecutorError('account_cgroup_invalid');
    }
    const { memory, swap, pids, cpu } = await readAccountLimits(base);
    if (!accountBudgetValid({ memory, swap, pids, cpu })) {
      throw new ExecutorError('sandbox_resource_controls_missing');
    }
  }

  async validateContainer(name, imageId) {
    const values = await this.json(['inspect', '--type', 'container', '--', name]);
    const container = values[0];
    if (container?.State?.OOMKilled) throw new ExecutorError('sandbox_resource_terminated', 409);
    const host = container?.HostConfig;
    const expectedUlimits = { nproc: 64, nofile: 256, core: 0 };
    if (values.length !== 1 || !container.State?.Running || container.Image !== imageId ||
        !Number.isSafeInteger(container.State.Pid) || container.State.Pid <= 0 ||
        host?.Runtime !== 'runsc' || host.NetworkMode !== 'none' || !host.ReadonlyRootfs ||
        host.Privileged || (host.Binds?.length ?? 0) || (host.CapAdd?.length ?? 0) ||
        (host.Devices?.length ?? 0) || (host.DeviceRequests?.length ?? 0) ||
        (host.GroupAdd?.length ?? 0) || host.PidMode !== '' || host.IpcMode !== 'private' ||
        host.UTSMode !== '' || host.LogConfig?.Type !== 'none' ||
        Object.keys(host.Tmpfs ?? {}).length !== 2 ||
        Object.entries(sandboxTmpfs).some(([key, value]) => host.Tmpfs?.[key] !== value) ||
        host.Ulimits?.length !== 3 || Object.entries(expectedUlimits).some(([name, bound]) =>
          !host.Ulimits?.some(limit => limit.Name === name && limit.Soft === bound && limit.Hard === bound)) ||
        !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges') ||
        host.SecurityOpt.some(item => item.startsWith('seccomp=')) ||
        container.Config?.User !== '65533:65533' || container.Config?.Hostname !== 'sandbox' ||
        container.Mounts?.some(mount => mount.Type !== 'tmpfs' || !['/workspace', '/tmp'].includes(mount.Destination))) {
      throw new ExecutorError('sandbox_configuration_invalid');
    }
    const membership = await readFile(`/proc/${container.State.Pid}/cgroup`, 'utf8');
    const entry = membership.trim().split('\n').find(line => line.startsWith('0::'));
    const relative = entry?.slice(3);
    const account = `/user.slice/user-${this.config.hostUid}.slice/`;
    if (!relative?.startsWith(account) || relative.split('/').includes('..')) {
      throw new ExecutorError('sandbox_cgroup_invalid');
    }
    await this.validateAccountBudget();
    return container.Id;
  }
}

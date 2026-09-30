import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { configuration } from '../src/config.js';
import { Sessions } from '../src/sessions.js';

const sessions = new Sessions(configuration());
const lock = net.createServer(socket => socket.destroy());
lock.listen(3101, '127.0.0.1');
await once(lock, 'listening');
const signal = () => new AbortController().signal;
try {
  await sessions.initialize();
  await sessions.execute('probe', 'true', signal());
  const record = sessions.records.get('probe');
  const target = sessions.docker.run(['exec', '--user', '65532:65534', record.name,
    '/usr/bin/python3', '-I', '-c',
    'import ctypes,os,time;libc=ctypes.CDLL(None);assert libc.prctl(4,0,0,0,0)==0;open("/workspace/helper.pid","w").write(str(os.getpid()));time.sleep(10)'],
  { timeoutMs: 15000 });
  const protection = `import ctypes,errno,os,time
for _ in range(100):
 try:
  pid=int(open('/workspace/helper.pid').read());break
 except (FileNotFoundError,ValueError): time.sleep(.01)
else: raise AssertionError('helper did not start')
status=open(f'/proc/{pid}/status').read()
assert next(line for line in status.splitlines() if line.startswith('Gid:')).split()[1]=='65534'
try: os.open(f'/proc/{pid}/mem',os.O_RDWR)
except OSError as e: assert e.errno in (errno.EPERM,errno.EACCES)
else: raise AssertionError('helper memory accessible')
libc=ctypes.CDLL(None,use_errno=True)
libc.ptrace.restype=ctypes.c_long
assert libc.ptrace(16,pid,0,0)==-1
assert ctypes.get_errno() in (errno.EPERM,errno.ENOSYS)
class Vec(ctypes.Structure): _fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]
buf=ctypes.create_string_buffer(1);local=Vec(ctypes.cast(buf,ctypes.c_void_p),1);remote=Vec(1,1)
libc.process_vm_writev.restype=ctypes.c_long
assert libc.process_vm_writev(pid,ctypes.byref(local),1,ctypes.byref(remote),1,0)==-1
assert ctypes.get_errno() in (errno.EPERM,errno.ENOSYS)
print('PASS helper protection')
`;
  const protectedResult = await sessions.execute('probe', 'python3 verify.py', signal(), {
    files: [{ path: 'verify.py', content: Buffer.from(protection).toString('base64') }],
  });
  assert.equal(protectedResult.exitCode, 0);
  assert.equal(protectedResult.stdout.trim(), 'PASS helper protection');
  assert.equal((await target).exitCode, 137);
  console.log('PASS same-UID helper protection with different GID and nondumpable mode');

  const run = sessions.docker.run.bind(sessions.docker);
  sessions.docker.run = (args, options) => {
    if (args.includes('/usr/local/lib/qfli/cleanup.py')) {
      return run([...args.slice(0, args.indexOf('/usr/bin/python3')), '/bin/sh', '-c', 'kill -KILL $$'], options);
    }
    return run(args, options);
  };
  await assert.rejects(sessions.execute('probe', 'echo command-complete', signal()),
    error => error.code === 'sandbox_not_quiescent');
  sessions.docker.run = run;
  assert.equal(sessions.records.size, 0);
  assert.equal((await sessions.docker.owned()).length, 0);
  console.log('PASS injected helper death destroys the real session');

  await sessions.execute('probe', 'true', signal());
  const remove = sessions.docker.remove.bind(sessions.docker);
  sessions.docker.remove = async () => { throw new Error('injected deletion failure'); };
  await assert.rejects(sessions.reset('probe'), error => error.code === 'container_cleanup_pending');
  assert.equal(sessions.ready, false);
  assert.equal(sessions.records.size, 1);
  assert.equal((await sessions.docker.owned()).length, 1);
  await assert.rejects(sessions.execute('new-user', 'true', signal()), error => error.code === 'terminal_unavailable');
  sessions.docker.remove = remove;
  await sessions.reconcile();
  assert.equal(sessions.records.size, 0);
  assert.equal(sessions.ready, true);
  console.log('PASS injected deletion failure retains capacity and blocks admission until confirmed cleanup');

  await sessions.execute('abandoned', 'touch /workspace/orphan-proof', signal());
  clearInterval(sessions.timer);
  sessions.stopping = true;
  const replacement = new Sessions(configuration());
  try {
    await replacement.initialize();
    assert.equal((await replacement.docker.owned()).length, 0);
    console.log('PASS restart reconciliation removes the real owned orphan');
  } finally {
    assert.equal(await replacement.shutdown(), true);
  }
} finally {
  assert.equal(await sessions.shutdown(), true);
  await new Promise(resolve => lock.close(resolve));
}

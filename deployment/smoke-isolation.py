"""Run as a normal user snapshot, with no access to installer credentials."""

import errno
import os
import socket
import signal
import time
import resource
from ctypes import CDLL, c_int, c_long, c_size_t, c_void_p, Structure, byref, cast, create_string_buffer, get_errno


assert (os.getuid(), os.getgid()) == (65532, 65532)
with open('/proc/mounts', encoding='ascii') as mounts:
    options = {fields[1]: set(fields[3].split(',')) for fields in map(str.split, mounts)}
assert 'noexec' not in options['/workspace'], options['/workspace']
assert 'noexec' in options['/tmp'], options['/tmp']
assert os.statvfs('/workspace').f_blocks * os.statvfs('/workspace').f_frsize == 256 * 1024 * 1024
assert os.statvfs('/tmp').f_blocks * os.statvfs('/tmp').f_frsize == 64 * 1024 * 1024
assert resource.getrlimit(resource.RLIMIT_NPROC) == (64, 64)
for key in ("QFLI_TERMINAL_SECRET", "DOCKER_HOST", "XDG_RUNTIME_DIR"):
    assert key not in os.environ, key
for location in ("/home/qfli-runner", "/var/run/docker.sock", "/run/user"):
    assert not os.path.exists(location), location
try:
    with open("/usr/local/lib/qfli/init.py", "ab"):
        raise AssertionError("trusted rootfs is writable")
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), error

with socket.socket() as connection:
    connection.settimeout(1)
    try:
        connection.connect(("1.1.1.1", 443))
    except OSError:
        pass
    else:
        raise AssertionError("external network is reachable")

try:
    os.kill(1, signal.SIGSTOP)
except PermissionError:
    pass
else:
    raise AssertionError('user can stop the supervisor')
time.sleep(0.1)
with open("/proc/1/status", encoding="ascii") as status:
    state = next(line for line in status if line.startswith("State:"))
assert "T (stopped)" not in state, state
try:
    os.open('/proc/1/mem', os.O_RDWR)
except OSError as error:
    assert error.errno in (errno.EACCES, errno.EPERM), error
else:
    raise AssertionError('supervisor memory is accessible')

libc = CDLL(None, use_errno=True)
libc.ptrace.argtypes = [c_long, c_int, c_void_p, c_void_p]
libc.ptrace.restype = c_long
assert libc.ptrace(16, 1, None, None) == -1, 'ptrace attach to supervisor succeeded'
assert get_errno() in (errno.EPERM, errno.ENOSYS), get_errno()

class IOVec(Structure):
    _fields_ = [('base', c_void_p), ('size', c_size_t)]

buffer = create_string_buffer(1)
local = IOVec(cast(buffer, c_void_p), 1)
remote = IOVec(c_void_p(1), 1)
libc.process_vm_writev.argtypes = [c_int, c_void_p, c_size_t, c_void_p, c_size_t, c_size_t]
libc.process_vm_writev.restype = c_long
assert libc.process_vm_writev(1, byref(local), 1, byref(remote), 1, 0) == -1
assert get_errno() in (errno.EPERM, errno.ENOSYS), get_errno()
print("PASS isolation")

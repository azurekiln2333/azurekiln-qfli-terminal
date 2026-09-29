"""Kill every user process in this session, then prove it is quiescent."""

import os
import signal
import sys
import time
from ctypes import CDLL, c_int, c_ulong


CLEANUP_SECONDS = 2
MAX_PIDS = 64


def protect_process():
    libc = CDLL(None)
    libc.prctl.argtypes = [c_int, c_ulong, c_ulong, c_ulong, c_ulong]
    libc.prctl.restype = c_int
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise RuntimeError("process protection unavailable")


def remaining_pids(helper_pid):
    # /proc is the runtime-owned PID namespace, never a workspace input.
    with os.scandir("/proc") as entries:
        pids = []
        for entry in entries:
            if entry.name.isascii() and entry.name.isdecimal():
                pid = int(entry.name)
                if pid > 1 and pid != helper_pid:
                    pids.append(pid)
                    if len(pids) > MAX_PIDS:
                        raise RuntimeError("pid budget exceeded")
    return pids


def main():
    protect_process()
    helper_pid = os.getpid()
    if helper_pid <= 1 or os.getuid() != 65532 or os.getgid() != 65534:
        raise RuntimeError("unexpected sandbox identity")
    deadline = time.monotonic() + CLEANUP_SECONDS
    empty_scans = 0
    while time.monotonic() < deadline:
        pids = remaining_pids(helper_pid)
        if not pids:
            empty_scans += 1
            if empty_scans >= 2:
                sys.stdout.write('{"quiescent":true}\n')
                sys.stdout.flush()
                return
        else:
            empty_scans = 0
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        # Allow PID 1 to reap zombies; repeated scans catch concurrent forks.
        time.sleep(0.01)
    raise RuntimeError("session processes did not become quiescent")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("sandbox cleanup failed\n")
        raise SystemExit(70)

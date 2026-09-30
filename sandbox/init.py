"""Trusted PID 1: reap children and enforce a lease without runner cooperation."""

import os
import signal
import time
from ctypes import CDLL, c_int, c_ulong


LEASE_SECONDS = 1800
MAX_TASKS = 64
stopping = False


def protect_process():
    libc = CDLL(None)
    libc.prctl.argtypes = [c_int, c_ulong, c_ulong, c_ulong, c_ulong]
    libc.prctl.restype = c_int
    # PR_SET_DUMPABLE=4; PR_GET_DUMPABLE=3. Fail closed on unsupported runtimes.
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise SystemExit(70)


def reap_children(deadline):
    # A fork/exit storm must never postpone the independent hard deadline.
    for _ in range(64):
        if stopping or time.monotonic() >= deadline:
            return
        try:
            child, _ = os.waitpid(-1, os.WNOHANG)
            if child == 0:
                return
        except ChildProcessError:
            return
        except InterruptedError:
            continue


def terminate(_signum, _frame):
    global stopping
    stopping = True


def enforce_task_budget(deadline):
    tasks = 0
    with os.scandir("/proc") as processes:
        for process in processes:
            if not process.name.isascii() or not process.name.isdecimal():
                continue
            if stopping or time.monotonic() >= deadline:
                os._exit(0)
            try:
                with os.scandir(f"/proc/{process.name}/task") as threads:
                    for thread in threads:
                        if thread.name.isascii() and thread.name.isdecimal():
                            tasks += 1
                            if tasks > MAX_TASKS or time.monotonic() >= deadline:
                                os._exit(70)
            except FileNotFoundError:
                # Exiting processes can disappear between the two proc scans.
                continue


def main():
    protect_process()
    if os.getpid() != 1 or os.getuid() != 65533 or os.getgid() != 65533:
        raise SystemExit(70)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    deadline = time.monotonic() + LEASE_SECONDS
    # The executor consumes this handshake before admitting any user process.
    fd = os.open("/tmp/.qfli-init-ready", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "wb") as marker:
        marker.write(b"ready\n")
    while not stopping and time.monotonic() < deadline:
        reap_children(deadline)
        enforce_task_budget(deadline)
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))

    # Exiting the namespace init tears down every remaining user process.
    os._exit(0)


if __name__ == "__main__":
    main()

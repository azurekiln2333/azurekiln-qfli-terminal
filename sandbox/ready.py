"""Check the trusted init handshake before any user command is admitted."""

import os
import stat
import sys
import time


MARKER = "/tmp/.qfli-init-ready"


def main():
    if os.getpid() <= 1 or os.getuid() != 65532 or os.getgid() != 65532:
        raise RuntimeError("unexpected sandbox identity")
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            fd = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            time.sleep(0.01)
            continue
        with os.fdopen(fd, "rb") as marker:
            metadata = os.fstat(marker.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 65533 or metadata.st_gid != 65533:
                raise RuntimeError("unexpected readiness marker")
            content = marker.read(16)
        if content == b"ready\n":
            # The supervisor owns this marker in sticky /tmp; users cannot alter it.
            os.mkdir("/workspace/.tmp", 0o700)
            sys.stdout.write('{"ready":true}\n')
            sys.stdout.flush()
            return
        time.sleep(0.01)
    raise RuntimeError("supervisor readiness timeout")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("sandbox readiness failed\n")
        raise SystemExit(70)

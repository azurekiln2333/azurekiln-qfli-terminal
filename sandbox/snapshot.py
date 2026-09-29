"""Write a bounded project snapshot to a fresh sandbox-only directory."""

import base64
import json
import os
import secrets
import sys
from ctypes import CDLL, c_int, c_ulong


MAX_INPUT = 384 * 1024
MAX_BYTES = 256 * 1024
MAX_FILES = 64
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def main():
    libc = CDLL(None)
    libc.prctl.argtypes = [c_int, c_ulong, c_ulong, c_ulong, c_ulong]
    libc.prctl.restype = c_int
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise RuntimeError("process protection unavailable")
    if os.getuid() != 65532 or os.getgid() != 65534:
        raise RuntimeError("unexpected sandbox identity")
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("snapshot input exceeds budget")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"files"}:
        raise ValueError("invalid snapshot")
    files = value["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("invalid file count")
    decoded = []
    paths = set()
    total = 0
    for file in files:
        if not isinstance(file, dict) or set(file) != {"path", "content"}:
            raise ValueError("invalid file")
        relative, content = file["path"], file["content"]
        if not isinstance(relative, str) or not isinstance(content, str):
            raise ValueError("invalid file types")
        parts = relative.split("/")
        if (not relative or len(relative.encode("utf-8")) > 512 or len(parts) > 16
                or any(ord(char) < 32 or ord(char) == 127 or char == "\\" for char in relative)
                or any(part in ("", ".", "..") or len(part.encode("utf-8")) > 255 for part in parts)
                or relative in paths or len(content) > ((MAX_BYTES + 2) // 3) * 4):
            raise ValueError("invalid relative path or content")
        data = base64.b64decode(content, validate=True)
        if base64.b64encode(data).decode("ascii") != content:
            raise ValueError("noncanonical base64")
        total += len(data)
        if total > MAX_BYTES:
            raise ValueError("snapshot exceeds budget")
        paths.add(relative)
        decoded.append((parts, data))
    for parts, _ in decoded:
        if any("/".join(parts[:index]) in paths for index in range(1, len(parts))):
            raise ValueError("file directory conflict")
    # Resolve components through directory handles, never through workspace links.
    workspace = os.open("/workspace", DIRECTORY_FLAGS)
    name = ".qfli-run-" + secrets.token_hex(16)
    try:
        os.mkdir(name, mode=0o700, dir_fd=workspace)
        root = os.open(name, DIRECTORY_FLAGS, dir_fd=workspace)
        try:
            for parts, data in decoded:
                parent = os.dup(root)
                try:
                    for part in parts[:-1]:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=parent)
                        except FileExistsError:
                            pass
                        child = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
                        os.close(parent)
                        parent = child
                    fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=parent)
                    with os.fdopen(fd, "wb") as output:
                        output.write(data)
                finally:
                    os.close(parent)
        finally:
            os.close(root)
    finally:
        os.close(workspace)
    sys.stdout.write(json.dumps({"cwd": "/workspace/" + name}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("sandbox snapshot failed\n")
        raise SystemExit(70)

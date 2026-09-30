# Runtime validation

Both host families passed toolchain and isolation tests in independent WSL
installations. This is not production ECS kernel acceptance. Public deployment
is not recommended while memory-pressure recovery and production-host checks
remain incomplete.

## Tested Environment

Validation date: 2026-09-30. All three imported distributions share kernel
`6.6.114.1-microsoft-standard-WSL2`, and use gVisor
`release-20260921.0` with rootless Docker and cgroup v2/systemd.

| Distribution | OS / systemd | Runner UID | Docker |
| --- | --- | --- | --- |
| qfli-terminal-test | Ubuntu 24.04 / 255 | 1000 | 29.8.1 |
| qfli-terminal-al3-test | Alibaba Cloud Linux 3 / 239 | 2000 | 26.1.3 |
| qfli-terminal-al3-clean | Fresh AL3 / 239 | 3000 | 26.1.3 |

The Ubuntu rootfs came from the official minimal 24.04 image, SHA-256
`094dc0afc6ded1c3e5ce71f7d0b48d5db922155097bc8fb1ec19db2ebdd17ece`.
The fresh AL3 fixture used the official rootfs with only systemd/util-linux
prepared for WSL boot and UID_MIN changed to avoid shared-kernel cgroup
collisions. It initially had no terminal account, Docker, tar, gVisor or SDK.
Its final installer used `--base-image mirror.gcr.io/library/debian:trixie-slim`.
Existing systems, including `qfli-java-build`, were not changed.

## Acceptance Evidence

| Check | Ubuntu 24.04 | Alibaba Cloud Linux 3 / systemd 239 |
| --- | --- | --- |
| Fresh bootstrap prepares account and rootless prerequisites | Passed | Passed on fresh UID 3000 fixture |
| Complete image built from source | Passed | Passed, including fresh fixture |
| Actual sandbox PID belongs to bounded account cgroup | Passed | Passed |
| C, C++, Java, Lua, Node, Python, PHP, Go, Rust, Dart compile/run | Passed | Passed |
| Read-only rootfs, no network, host files, socket or business credentials | Passed | Passed |
| Supervisor SIGSTOP/ptrace/proc-mem/process_vm denied | Passed | Passed |
| Background cleanup, reset, 100 KiB output bound, 60-second deadline | Passed | Passed |
| HTTP authentication, malformed requests, capacity, UTF-8, disconnect, active reset, snapshots | Passed | Passed |
| Twenty consecutive C++ and twenty Dart compilation/cleanup operations | Passed | Passed |
| Protected helper, helper death, failed deletion, orphan reconciliation | Passed | Passed |
| Effective CPU, memory, zero swap and host-task cgroups | Passed | Passed |
| Actual CPU throttling and tmpfs exhaustion | Passed | Passed |
| Guest task storm termination and eventual health recovery | Passed | Passed |
| Authenticated health and repeat install preserving service PIDs/timestamps | Passed | Passed, including fresh fixture |
| Reboot starts Docker/executor with linger, no installer rerun | Passed | Passed, including fresh UID 3000 fixture |
| Actual old image/executor upgraded to version 2 | Passed | Passed on retry; see cleanup observation |
| Direct memory-pressure/OOM automatic recovery | Not accepted | Failed under MemoryHigh; see below |
| Outer shell ignores an OOM-killed child's exit | Not reached | Not reached |
| Production ECS kernel and 2 CPU / 2 GiB co-location | Not tested | Not tested |

The effective account settings were `cpu.max=100000 100000`,
`memory.max=1073741824`, `memory.swap.max=0`, `pids.max=1024`, and
`memory.high=805306368`. The rootless daemon, gVisor, executor and sole session
share this budget. `/workspace` and `/tmp` were verified as 256/64 MiB tmpfs;
the former is executable and the latter noexec. Guest nproc is 64, with the
supervisor's task guard terminating storms. The test does not promise zero
transient task excess.

Actual sandbox versions from the fresh AL3 HTTP execution path: GCC/G++ 14.2.0,
javac 21.0.12.1, Lua 5.4.7, Node 24.15.0/npm 11.12.1, Python 3.13.5,
PHP 8.4.26, Go 1.24.4, rustc/Cargo 1.85.1 and Dart 3.13.5. Java, Go,
Rust/Cargo, C/C++ and Dart native compilation were exercised; Python venv/pip
and Maven, LuaRocks, npm and Composer availability were also checked. External
dependencies cannot be downloaded inside the network-disabled sandbox.

The legacy upgrade fixture came from commit `2c5b213`. Its real image reported
Node 18.20.4 and Java 17.0.20.1, with Go/Dart absent. Preparing that old image
required its supported Debian mirror and a CA-prepared bookworm base. This
fixture preparation is distinct from the current bootstrap.

The first AL3 legacy upgrade returned `sandbox_not_quiescent` after the Dart
command. The installer left the executor disabled, and retrying passed all ten
languages plus the remaining checks. A subsequent direct-session run completed
20 consecutive Dart compilations/cleanups with account usage around 232-238 MiB
and no memory high/max/OOM events. This did not reproduce the original failure;
its cause remains unconfirmed. The HTTP suite now repeats both C++ and Dart 20
times to retain coverage. Do not classify the first failure as a fixed bug.

## Memory-Pressure Limitation

The AL3 direct-allocation probe increased `memory.events.high` from 0 to 10090;
`max`, `oom` and `oom_kill` remained zero. MemoryHigh throttled allocations and
Docker management before a host OOM kill. Removal exceeded its deadline,
execution returned `503 container_cleanup_pending`, and health remained 503
with one owned sandbox still charged. Reboot recovered the account and removed
the orphan. This is fail-closed accounting, not successful automatic OOM
recovery. The outer-shell-ignore case was not reached.

`test/runtime-resources.mjs --memory` recognizes this condition and exits 2,
retaining the sandbox reservation. Its default CPU/storage/task suite passes
and is separate from OOM acceptance. Do not lower the budget, ignore cleanup
failures or free the reservation to report a passing result. Operator recovery
must stop the executor, recover its dedicated Docker, confirm owned-container
removal, then restart the executor. Reboot recovery is the path tested here.

## Reproducing Checks

`deployment/verify-runtime.mjs` uses the same Sessions implementation as the
service. It takes the executor port lock before reconciliation, validates the
actual account budget and sandbox membership, then executes each language's
smoke program with the normal command deadline, mounts, environment and cleanup.
Failure leaves the executor disabled during bootstrap. Each language is tested
separately so a cold Go compilation does not consume the other languages' budget.

Run the HTTP and default resource suites as the dedicated runner with its clean
HOME/PATH, runtime directory, DBus address, Docker socket and runner env file.
Run the lifecycle suite with the executor stopped; it holds the same port lock.
These scripts are destructive to test sessions and must run only in an isolated
acceptance environment.

```sh
qfli-node --env-file="$HOME/.config/qfli-terminal/runner.env" test/runtime-http.mjs
qfli-node --env-file="$HOME/.config/qfli-terminal/runner.env" test/runtime-resources.mjs
# Stop qfli-terminal.service before the lifecycle suite.
qfli-node --env-file="$HOME/.config/qfli-terminal/runner.env" test/runtime-lifecycle.mjs
# Separate incomplete acceptance; operator recovery may be needed.
qfli-node --env-file="$HOME/.config/qfli-terminal/runner.env" test/runtime-resources.mjs --memory
```

Static verification passed: four Node unit tests, all JS/MJS syntax checks,
five Python AST checks, bootstrap Bash syntax, smoke script POSIX shell syntax
and scoped Git whitespace checks. Unit tests cover ineffective account limits,
supervisor identity/workspace mount flags, and command SDK environment
propagation. These checks are separate from Linux runtime evidence.
The final default Windows Node test launch exhausted system commit memory
before assertions ran. Repeating the four tests sequentially with a 64 MiB
old-space ceiling and 1 MiB semi-space passed; an earlier normal `npm test`
also passed. No Windows memory settings or unrelated build processes changed.

Local raw evidence is under `.artifacts/terminal-runtime-test/` in the parent
workspace: `ubuntu-final-release.log`, `ubuntu-final-idempotent.log`,
`ubuntu-final-reboot.log`, `ubuntu-upgrade.log`, `ubuntu-legacy-proof.log`,
`al3-clean-release.log`, `al3-clean-idempotent.log`, `al3-clean-versions.log`,
`al3-clean-reboot.log`, `al3-legacy-upgrade.log`, `al3-upgrade-retry.log`,
`ubuntu-http-final.log`, `al3-http-final.log`, `al3-cleanup-stability.log`,
the two hosts' `*-http.log`, `*-lifecycle.log`, `*-resources.log`, and
`al3-pressure-recovery.log`. Rootfs/VHD/image exports and test credentials are
not release contents and are not committed.

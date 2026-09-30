# QFLI 云端终端隔离服务

Ubuntu 24.04 与 AL3 / systemd 239 已在独立 WSL 环境通过十种语言、隔离和生命周期测试。生产 ECS 内核尚未验证，AL3 内存压力下的清理超时与 OOM 自动恢复仍是验收缺口，当前不建议公开部署；完整证据见 [runtime-validation.md](docs/runtime-validation.md)。

## 架构与边界

```text
App -> QFLI 业务 API -> 127.0.0.1:3101 执行服务
                           -> rootless Docker -> gVisor runsc -> 用户会话
```

终端工作区是会话内存盘，重置、超时、服务重启或会话到期都会丢失。云项目仍由业务后端独立持久保存，不挂载进沙箱，不自动迁移旧终端目录。业务后端的云项目 Git 接口暂时关闭，普通项目、文件和同步接口保留。

本服务面向用户运行任意代码，默认拒绝未满足隔离要求的宿主。必须使用 Linux、专用非 root 账号、rootless Docker、gVisor `runsc`、cgroup v2，以及执行账号上实际生效的 CPU/内存/任务数限制；缺一项就不开放执行。不会自动降级到普通 `runc` 或宿主 Shell。一次只保留一个用户会话，沙箱进程和执行服务、Docker daemon 共用该账号预算。

公开运营优先部署在专用执行虚拟机。也可与业务同机使用独立账号，但共享内核与系统资源仍有风险；容器与 gVisor不能保证绝对不会逃逸，宿主内核、Docker、gVisor 和镜像必须及时更新。

## 安装前先检查宿主

执行机须为 x86_64、cgroup v2，且能运行带 `--ignore-cgroups` 的 gVisor。Alibaba Cloud Linux 3.2104 的 systemd 239 不支持 gVisor 自行创建 systemd cgroup，因此安装器改为让 gVisor 使用执行账号已有的受限 cgroup；不要求更换服务器或重装系统。Docker daemon 仍为 `qfli-runner` 账号的 rootless 服务。容器不声明虚假的独立 CPU/内存限额，执行服务会核对宿主上的实际账号限额及沙箱进程归属；核对失败就不开放终端。

先在执行机上运行 `systemctl --version | head -1` 和 `stat -fc %T /sys/fs/cgroup`；兼容路径支持 systemd 239 起的用户 slice 接口，cgroup 必须是 `cgroup2fs`。安装器在下载前检查系统和 cgroup 模式，按需准备专用账号、从属 UID/GID、Docker Engine/CLI/rootless extras 和系统依赖。实际兼容性以本文件开头的验收记录为准。

从可信的上传目录将**新版**安装器复制到仅 root 可写的位置。`--source-dir` 指向完整源码目录，安装器会将源码安装到执行账号的家目录；首次安装无需预先创建账号。以下是安装器入口，开放终端前仍须完成验收记录：

```sh
install -o root -g root -m 0700 \
  /实际上传目录/azurekiln-qfli-terminal/deployment/bootstrap.sh \
  /root/qfli-terminal-bootstrap.sh
bash /root/qfli-terminal-bootstrap.sh \
  --source-dir /实际上传目录/azurekiln-qfli-terminal
```

脚本会隐藏输入**业务后端已经使用的** 64 位十六进制终端密钥；不能在聊天或日志中粘贴密钥。已知业务 `.env` 路径时，也可运行 `bash /root/qfli-terminal-bootstrap.sh --business-env /实际业务后端目录/.env`，脚本只读取其中的 `QFLI_TERMINAL_SECRET`，不会复制业务配置到执行账号。若业务后端尚未配置终端密钥，先按下文“连接业务后端”配置两端相同的独立密钥。安装器不会替你修改或重启业务服务。

脚本会优先从系统或宝塔已安装的 Node.js 22.9+ 复制一份到 `/usr/local/bin/qfli-node`；没有可用版本时从 Node.js 官网下载最新的 24.x Linux x64 包并校验 SHA-256。它还会校验 gVisor 下载、设置执行账号整体限额、配置专用 rootless Docker、构建沙箱镜像并写入专用密钥文件。随后用真实 Sessions 逐个编译/运行语言，验证隔离、快照、后台清理、重置、输出上限和命令超时，通过后才安装并启用终端服务，检查带认证的 `/health`。下载和首次镜像构建可能需要几分钟；已验收的同一源码版本在运行时重跑只检查健康，不重启 Docker 或终端。源码变化会停止旧终端、更新并重新验收；失败时保持终端禁用。

在受支持的执行机升级旧版终端服务时，若服务因 Docker 启动失败而每 5 秒重启，先以 root 停止该专用用户服务，再上传新版目录并重新复制、运行安装器。安装器会迁移旧的 `runsc --rootless=true` 与单文件日志压缩设置，重启执行账号的 Docker，并先做一个无网络的 gVisor 容器启动检查；检查不通过时不会启动终端服务。

```sh
runner_uid=$(id -u qfli-runner)
runuser -u qfli-runner -- env XDG_RUNTIME_DIR=/run/user/$runner_uid \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$runner_uid/bus \
  systemctl --user stop qfli-terminal.service
```

Docker Hub 拉取 Debian 基础镜像失败时，安装器自动尝试 Google 官方的 `mirror.gcr.io/library/debian:trixie-slim` 缓存源。管理员也可通过 `--registry-mirror` 使用可信 HTTPS Docker Hub 加速地址，或通过 `--base-image` 选择已审核的基础镜像。镜像加速配置只写入执行账号的 rootless Docker，保留 `runsc`；不会修改宿主 root Docker 配置。禁止关闭 TLS 校验。`--debian-mirror` 仅用于镜像内部的 apt 下载；Dockerfile 先用 Debian 默认签名源安装 CA，再切换镜像站，避免 HTTP 转 HTTPS 时缺少 CA。

**开机无需再次运行脚本。** 安装器设置 `loginctl enable-linger qfli-runner`，并启用该账号的 `docker.service` 与 `qfli-terminal.service`；systemd 在服务器重启后自动启动它们。首次安装成功后仍须确认业务后端使用相同的密钥。仅同机部署才可使用 `QFLI_TERMINAL_URL=http://127.0.0.1:3101`；独立执行机需要受来源限制、证书有效的内部 HTTPS 入口，然后把业务后端的 URL 指向该入口。重启业务服务并做下文的 Linux 上线验收。以下分步命令保留用于排障和手工维护。

## 固定限额

| 项目 | 限额 |
| --- | --- |
| 总会话 / 同时执行 | 1 / 1，创建、命令及命令后清理占用执行槽 |
| 等待队列 | FIFO 最多 8 条，最多等待 20 秒 |
| 每用户 | 1 个会话；执行或等待请求合计最多 1 条 |
| 执行账号整体 CPU / 内存 / swap | 1 核 / 1 GiB / 0；包含 Docker、gVisor、Node 与唯一沙箱 |
| 执行账号宿主任务数 / 沙箱内用户任务数 | 1024 / 64，后者由 `nproc` 和 PID 1 监测 |
| `/workspace` / `/tmp` | 256 MiB / 64 MiB tmpfs |
| 命令时间 / 合并输出 | 60 秒 / 100 KiB |
| 空闲期限 / 绝对期限 | 2 分钟 / 30 分钟 |
| 项目快照 | 最多 64 文件、解码后合计 256 KiB；HTTP 请求最多 384 KiB |
| 执行账号整体 | MemoryHigh 768 MiB、MemoryMax 1 GiB、TasksMax 1024；启动和每次命令前检查 |
| 外网 | 完全关闭，包括下载包、SSH 与 Git 远程操作 |

根文件系统只读，用户命令为 `65532:65532`，监督进程为独立非 root 身份 `65533:65533`，所有 capabilities 被移除，启用 `no-new-privileges` 和默认 seccomp。不挂载宿主目录、设备、卷或 Docker socket，不共享宿主 PID/网络命名空间。`/workspace` 显式带 `exec`，允许执行用户编译的程序，并保留 `nosuid,nodev`；`/tmp` 另带 `noexec`。

镜像基于 Debian trixie，提供下列工具链；Node.js 和 Dart 官方下载包固定版本与 SHA-256，其他工具使用 Debian 已签名的软件包。

| 语言 | 工具 |
| --- | --- |
| C / C++ | GCC / G++、Make、CMake、pkg-config |
| Java | OpenJDK 21（java / javac）、Maven |
| Lua | Lua 5.4、LuaRocks |
| Node.js | Node.js 24.15.0、npm |
| Python | Python 3、pip、venv |
| PHP | PHP CLI、Composer |
| Go | Go 编译器与标准库 |
| Rust | rustc、Cargo |
| Dart | Dart SDK 3.13.5、JIT 运行与原生可执行文件编译 |

工作区 `.tmp` 由就绪检查创建，用于需要可执行临时文件的编译器。Java 默认最大堆为 256 MiB、识别 1 个处理器；Go 和 Cargo 默认单路构建，适配账号整体预算。镜像由管理员构建；用户不能在会话内安装系统包。外网关闭，包管理器可运行本地项目和已有依赖，但不能下载 Maven / npm / pip / Composer / Cargo / pub 的远程依赖。内存、存储和时间限额会限制大型构建，程序可能失败或被终止。

默认预算面向 2 核 / 2 GiB 小服务器：唯一沙箱与 rootless Docker、gVisor、执行 Node 共用账号的 1 核 / 1 GiB 硬上限。达到上限会造成 OOM 或终端服务不可用；OS、业务 Node、数据库和宝塔还需共用剩余资源。编译大型项目可能超出预算，不能仅因镜像包含编译器就承诺任意项目都能构建。

排队只缓冲短时请求，不提高吞吐量。单个执行槽的命令最长 60 秒，另需初始化、上传与清理时间；连续长命令时，靠后的请求可能在 20 秒内等不到机会。空闲会话仍占唯一容量；其他用户会收到“会话已满”，需等待退出释放、2 分钟空闲回收或手动重置。队列满与会话满使用不同提示，客户端断开、重置、等待超时或服务关闭会移除等待项并更新位置。删除失败仍占容量并停止新执行。需要持续服务更多用户时增加独立执行资源，不能只扩大队列。

## 请求与进度

- `POST /api/terminal/exec/stream`（业务 API）转发到内部 `POST /v1/exec/stream`，响应为 `application/x-ndjson`；JSON `POST /api/terminal/exec` 继续兼容。
- 请求为 `{command,files?}`；每个快照文件为 `{path,content}`，`content` 必须是规范 base64。路径是相对 POSIX 路径，禁止绝对路径、空段、`.`、`..`、反斜线、控制字符、重复文件与文件/目录冲突；单路径最多 512 UTF-8 字节、16 段，每段最多 255 字节。
- 进度事件为 `{type:'progress',stage,position?}`，阶段为 `queued`（1 起始位置）、`initializing`、`ready`、`uploading`、`running`、`cleaning`。输出事件为 `{type:'stdout'|'stderr',text}`，UTF-8 跨数据块正确解码；慢接收端最多等待 5 秒，随后取消执行并回收会话。
- 最后一条是 `{type:'result',stdout,stderr,exitCode,cwd:'/workspace'}` 或 `{type:'error',message,status}`。输出已通过输出事件显示时，客户端不能再重放结果中的输出。内部错误代码由业务层转换为中文；流启动前的验证、认证及限流错误仍返回常规 HTTP JSON。
- 合并输出最多 100 KiB；NDJSON 经转义且包含最终结果，另限制编码后流总量 2 MiB、单行 700 KiB。业务层验证事件、最终输出和退出码后转发，并等待客户端 drain，避免无限缓冲。

项目快照由只读镜像里的 `snapshot.py` 通过有大小上限的 Docker stdin 写入新的 `/workspace/.qfli-run-<随机值>`。工具使用不同 GID、不可转储保护、目录句柄及 `O_NOFOLLOW`，从不读取宿主路径或挂载云存储。带 `files` 的命令在该新目录内运行；响应 `cwd` 保留兼容的工作区根元数据 `/workspace`，不表示该命令的实际子目录。普通手输命令仍从根目录执行，快照及生成文件受会话 tmpfs 上限约束，并在会话回收时丢失。

命令结束后只保留文件，全部后台进程被清理。清理不成功、命令超时、输出超额、连接断开、显式重置、到期或服务关闭，都销毁整个会话。PID 1 另有独立 30 分钟硬截止，执行服务死亡时依然生效。删除失败的会话继续占用容量，执行服务拒绝新增任务并持续尝试清理。

执行服务会检查容器 `State.OOMKilled` 与命令退出码 137；观察到 OOM 或 SIGKILL 退出就回收整个会话。账号级内存上限可能直接终止 Docker、gVisor 或 Node，服务会因此不可用而不接受新任务。gVisor 内部的 guest 内存耗尽不一定映射到这些宿主状态，例如子进程耗尽内存后被杀，但外层 Shell 忽略失败并返回 0。因此不能仅凭静态检查承诺所有 guest OOM 都必然触发回收；账号内存硬限额本身仍必须有效，并须在目标版本验证事件可见性。

gVisor 的宿主线程和用户看到的进程不是一一对应关系，所以账号级 `pids.max` 约束总宿主任务数，容器 `nproc=64:64` 与 PID 1 每约 50 毫秒检查用户可见进程/线程总数。轮询不能保证瞬时数量绝不越界；目标 gVisor 版本的 guest `nproc` 行为必须在 Linux 上验收，不能只看账号 cgroup 值就宣称用户进程限制已验证。

PID 1 使用 `65533:65533`，先调用 `PR_SET_DUMPABLE=0` 并验证成功，安装信号处理后写出该 UID 拥有的就绪标记。不同 UID 阻止用户暂停监督进程；仅设置不可转储不能阻止同 UID 的 `SIGSTOP`。受信 `ready.py` 在第一条用户命令前核对标记并创建编译器临时目录；标记留在 sticky `/tmp` 中，用户不能修改或删除，后续不再用于就绪判断。清理进程使用 `65532:65534`，用户命令为 `65532:65532`，通过不同 GID 阻止用户在清理进程启动瞬间使用 ptrace、`/proc/<pid>/mem` 或 `process_vm_writev` 修改它；清理进程还独立启用不可转储保护。保护不可用、就绪失败或 helper 身份不符都停止该会话。

## 先处理旧实例

旧终端曾使用业务账号执行宿主 Shell 并继承业务环境变量。部署隔离服务前：

1. 关闭旧公网终端入口并停掉旧实例，确认反向代理不会转发到旧版本。
2. 检查原业务账号的残留后台进程、定时任务、用户服务、SSH 授权和异常文件。停止 Node 并不能自动清除它曾启动的恶意后台进程。存在入侵迹象时在可信机器上重建宿主并恢复经过核查的数据。
3. 在可信环境轮换旧 QFLI JWT 密钥、数据库密码、OAuth2 客户端密钥和旧实例可访问的其他凭据。JWT 更换后旧 App 会话失效，需要重新登录。
4. 不删除真实云项目、旧终端目录、数据库或迁移记录。先前的 `迁移目标已存在` 是独立的数据迁移冲突，需要核对源目录与目标目录再处理。

拆分进程和账号不会使已经泄露的密钥重新安全。

## Linux 部署步骤

以下由服务器管理员在执行机上操作。需要 systemd 239+ 与 cgroup v2，独立账号名为 `qfli-runner`。安装器为执行服务准备 `/usr/local/bin/qfli-node`，建议 Node.js 24 LTS。宝塔的业务 Node 服务可继续使用自己的账号；不要把业务服务改成 `qfli-runner`。

### 1. 准备受支持的运行环境

Ubuntu 24.04 使用 Docker 官方 apt 仓库安装 Engine、CLI 和 `docker-ce-rootless-extras`（按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 配置仓库）；另外准备 `uidmap`、`dbus-user-session`、`slirp4netns`、`fuse-overlayfs`。安装器会按需安装 `xz-utils`、`zstd`，再安装完整 gVisor 发行包。发行版需要允许专用账号创建非特权用户命名空间；不要为此去除整个宿主的安全策略。

```sh
stat -fc %T /sys/fs/cgroup
systemctl --version | head -1
docker --version
id qfli-runner
grep '^qfli-runner:' /etc/subuid /etc/subgid
```

账号不存在时先用 `useradd --create-home --shell /bin/bash qfli-runner` 创建，再运行 `passwd -l qfli-runner` 和 `loginctl enable-linger qfli-runner`。已有账号也要确认 linger 为 `yes`：`loginctl show-user qfli-runner -p Linger -p RuntimePath`；若为 `no`，执行 `loginctl enable-linger qfli-runner`。

`stat` 必须显示 `cgroup2fs`，systemd 必须至少为 239；安装器会自行安装 `/usr/local/bin/qfli-node`。`/etc/subuid` 与 `/etc/subgid` 必须分配不少于 65536 个、不与其他账号冲突的从属 ID。按发行版的 rootless Docker 文档配置 systemd cgroup controller delegation；启动检测会读取实际宿主 cgroup 文件，不能只凭 Docker 的配置字段判断限额生效。

不要把任何业务账号加入 `docker` 组，不要使用 `sudo docker` 运行会话，也不要暴露 Docker daemon TCP 端口。执行账号只保管独立内部共享密钥，不能读取 MySQL、OAuth2 或 QFLI JWT 配置。核对业务 `.env` 的目录权限与文件权限，至少将文件限制为所属业务账号可读。

#### 当前 Alibaba Cloud Linux 3.2104 的限制

这台服务器已启用 cgroup v2，systemd 仍为 239。旧配置让 gVisor 自行申请 systemd cgroup，因而报 `systemd version 239 not supported`。新版改为 gVisor 不创建独立 cgroup，仍由 rootless Docker 的执行账号用户 slice 限制全部相关进程；同一时刻只准一个会话。先停止旧服务，上传新版目录后重跑安装器。必须等启动探针和实际账号限额检查通过，才能开放业务终端；不通过时不要关闭账号限额或切换 `runc`。

```sh
runner_uid=$(id -u qfli-runner)
runuser -u qfli-runner -- env XDG_RUNTIME_DIR=/run/user/$runner_uid \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$runner_uid/bus \
  systemctl --user disable --now qfli-terminal.service
```

#### 安装完整 gVisor 发行包

本项目的 rootless Docker 配置把 `runsc` 指向 `/usr/local/bin/runsc`。`docker info` 列出 `runsc` 只能证明配置项存在；必须确认二进制实际可执行。gVisor 当前发行包还包含 `containerd-shim-runsc-v1` 和 `gvisor-bin/` 辅助程序，不能只复制一个旧式 `runsc` 文件。下面是 [gVisor 官方手动安装方式](https://gvisor.dev/docs/user_guide/install/)在 RHEL 系发行版上的对应命令，由 root 执行；正式环境建议将 `latest` 换成审核过的日期版本并保存校验值与 `runsc --version` 输出。

```sh
dnf install -y zstd
install -d -m 0700 /root/qfli-gvisor-download
cd /root/qfli-gvisor-download
gvisor_release="https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)"
curl --fail --location --ipv4 --tls-max 1.2 --retry 3 --retry-max-time 900 \
  --connect-timeout 15 --max-time 600 --output gvisor.tar.zstd "$gvisor_release/gvisor.tar.zstd"
curl --fail --location --ipv4 --tls-max 1.2 --retry 3 --retry-max-time 90 \
  --connect-timeout 15 --max-time 60 --output gvisor.tar.zstd.sha512 "$gvisor_release/gvisor.tar.zstd.sha512"
set -o pipefail
sha512sum -c gvisor.tar.zstd.sha512 && \
  zstd -dc gvisor.tar.zstd | tar -xf - -C /usr/local/bin
/usr/local/bin/runsc --version
test -x /usr/local/bin/containerd-shim-runsc-v1
test -d /usr/local/bin/gvisor-bin
```

校验失败时停止安装。该目录的 `deployment/docker-daemon.json` 已为专用 rootless Docker 注册运行时；不要对宿主的 root Docker 运行 `runsc install` 来替代此配置。安装后以 `qfli-runner` 重启其用户级 Docker，并确认 `runsc` 仍在运行时列表中。Docker daemon 本身仍以非 root 账号运行；不要向 `runsc` 传 `--rootless=true`，当前 gVisor 的 OCI `create` 命令会明确拒绝该参数。运行时传入 `--network=none --ignore-cgroups`，因此容器本身不声明独立限额；服务启动前必须通过实际的 gVisor 容器、进程所属账号 cgroup 和账号资源限额检查；失败时不切换到 `runc`。

### 2. 设置执行账号整体资源上限

以 root 执行，根据专用账号的实际 UID 安装用户 slice 限额；例如当前服务器的 UID 为 `1003`，不要沿用别的机器上的数字：

```sh
runner_uid=$(id -u qfli-runner)
install -d -m 0755 "/etc/systemd/system/user-$runner_uid.slice.d"
install -m 0644 /home/qfli-runner/azurekiln-qfli-terminal/deployment/user-slice-limits.conf \
  "/etc/systemd/system/user-$runner_uid.slice.d/limits.conf"
systemctl daemon-reload
systemctl set-property "user-$runner_uid.slice" \
  CPUQuota=100% MemoryHigh=768M MemoryMax=1G MemorySwapMax=0 TasksMax=1024
systemctl show "user-$runner_uid.slice" \
  -p CPUQuotaPerSecUSec -p MemoryMax -p MemorySwapMax -p TasksMax
```

整个账号限制 1 核、1 GiB、无 swap、1024 tasks，覆盖 Docker daemon、gVisor、Node 与唯一用户会话。没有独立的每容器内存配额；实际总开销可能使账号到达上限。2 GiB 同机部署须监控账号用量、宿主剩余内存和业务数据库用量，大型编译容易触发限制。只配置专用执行账号的 slice。

### 3. 安装专用 rootless Docker

```sh
sudo -iu qfli-runner
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
if [ ! -e "$HOME/.config/systemd/user/docker.service" ]; then
  dockerd-rootless-setuptool.sh install
fi
mkdir -p "$HOME/.config/docker"
```

在执行账号的 `$HOME/.config/docker/daemon.json` 放入本项目 `deployment/docker-daemon.json`，然后：

```sh
systemctl --user daemon-reload
systemctl --user enable docker.service
systemctl --user restart docker.service
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
docker info
```

必须确认 `rootless`、cgroup v2、seccomp 和 `runsc` 注册成功，不能忽略 `No cpu cfs quota support`、`No memory limit support` 等警告。这里的 Docker socket 位于 `/run/user/<UID>/docker.sock`，权限只能属于执行账号。Docker 信息仅证明运行时已注册；必须让 `runsc` 真正启动隔离容器，并核对有效的 cgroup 限额。检查失败时保持业务终端关闭，不通过去掉资源限制或切换普通 runtime 绕过检查。专用 Docker 的默认 `local` 日志驱动设置 `max-file=1` 时必须关闭压缩，否则 Docker 会在容器启动前报 `compression cannot be enabled when max file count is 1`；终端沙箱自身仍使用 `--log-driver=none`。

从 root 的宝塔终端运行 `systemctl --user` 只会查询 root 的用户管理器，可能报 `Failed to connect to bus`，并不能说明 `qfli-runner` 服务状态。已有专用账号和 Docker socket 时，仍须切换到 `qfli-runner`，设置上面的 `XDG_RUNTIME_DIR` 与 `DBUS_SESSION_BUS_ADDRESS` 后查询其 `systemctl --user` 和 `journalctl --user`。

### 4. 构建可信镜像

将整个 `azurekiln-qfli-terminal` 目录部署到 `/home/qfli-runner/azurekiln-qfli-terminal`，仅执行账号与管理员可修改。不要复制业务 `.env`、数据目录或数据库凭据。以执行账号运行：

```sh
cd "$HOME/azurekiln-qfli-terminal"
docker build --pull -t qfli-terminal-sandbox:2 sandbox
docker image inspect qfli-terminal-sandbox:2
```

`docker image inspect` 若返回 `No such image`，表示镜像尚未构建；Docker socket 存在不代表沙箱镜像存在。构建、检查及后续执行服务必须使用同一个 `qfli-runner` rootless Docker socket。

如果目标服务器无法访问 Docker Hub，也没有可用的可信镜像加速地址，可在另一台受信、同为 Linux x86_64 的机器按本项目 Dockerfile 构建完整的 `qfli-terminal-sandbox:2` 镜像，通过 `docker save` 导出并校验传输文件，再在目标服务器的 **`qfli-runner` rootless Docker** 中 `docker load`。安装器仍须在真实会话中验证全部工具链、镜像用户、入口点和运行时隔离条件。旧 `:1` 镜像不满足工具链版本要求。不要只把基础镜像导入后重试默认构建，因为默认 `--pull` 仍会连接 Docker Hub。

如果构建长期停在 `apt-get install` 的 `Get:` 下载行（例如 Debian 包下载已经 5500 秒），耗时在镜像构建的网络下载阶段，尚未开始用户沙箱初始化。用 Ctrl-C 停止这次构建，核对服务器到可信镜像站的连通性后重新构建：

```sh
docker build --pull --progress=plain \
  --build-arg DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn \
  -t qfli-terminal-sandbox:2 sandbox
```

`DEBIAN_MIRROR` 填镜像站主地址，不额外带 `/debian`；Dockerfile 同时保留 Debian 主源与安全源路径，apt 签名校验仍开启。CA 由 Debian 默认签名源引导安装，之后允许镜像站跳转到 HTTPS；禁止设置 `Verify-Peer=false`。软件索引有任一下载失败时终止构建。下载连接/无数据超时为 30 秒、重试最多 2 次，并使用 IPv4；这不是整层构建的 30 秒总截止，下载吞吐持续很低时应换可信镜像源。不要使用 `trusted=yes` 或关闭签名校验。Node 和 Dart 下载使用 TLS 1.2、重试及备用源，备用文件仍必须通过官方固定 SHA-256 校验。构建层按 CA、系统工具、Node、Dart 分开缓存。

生产升级建议固定经过审核的 Debian 基础镜像 digest：使用 `--build-arg BASE_IMAGE=debian:trixie-slim@sha256:<审核后的digest>`。构建只允许管理员触发，不提供镜像名、Dockerfile 或挂载参数的用户输入。执行服务启动后将标签解析成不可变 image ID，每个会话都使用该 ID；更新镜像必须重启执行服务并重新通过检测。

镜像必须含 `io.qfli.terminal.image=1` 与 `io.qfli.terminal.toolchains=2` 标签，监督用户 `65533:65533`，精确 entrypoint `[/usr/bin/python3,-I,/usr/local/lib/qfli/init.py]`，且没有声明 volumes。安装器用 `io.qfli.terminal.sandbox-source` 记录沙箱源码指纹，不匹配时重建；手工加载的镜像也需要匹配当前源码。不要复用包含业务密钥的镜像。

### 5. 配置并启动执行服务

```sh
install -d -m 0700 "$HOME/.config/qfli-terminal"
test -e "$HOME/.config/qfli-terminal/runner.env" || \
  install -m 0600 /dev/null "$HOME/.config/qfli-terminal/runner.env"
${EDITOR:-vi} "$HOME/.config/qfli-terminal/runner.env"
```

仅首次部署且两端均无内部密钥时，先用 `openssl rand -hex 32` 生成一次并保存到受控凭据存储，再填入两端；业务后端已有密钥时直接使用已有值。

将生成的独立密钥填写到 `$HOME/.config/qfli-terminal/runner.env`，格式为：

```dotenv
QFLI_TERMINAL_SECRET=这里填写生成的64位十六进制密钥
QFLI_TERMINAL_IMAGE=qfli-terminal-sandbox:2
```

文件权限为 `0600`。将 `deployment/qfli-terminal.service` 安装到 `$HOME/.config/systemd/user/qfli-terminal.service`，运行：

```sh
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 deployment/qfli-terminal.service "$HOME/.config/systemd/user/qfli-terminal.service"
chmod 0600 "$HOME/.config/qfli-terminal/runner.env"
/usr/local/bin/qfli-node --env-file="$HOME/.config/qfli-terminal/runner.env" deployment/verify-runtime.mjs
systemctl --user daemon-reload
systemctl --user enable --now qfli-terminal.service
systemctl --user status qfli-terminal.service
journalctl --user -u qfli-terminal.service -n 100 --no-pager
ss -ltn | grep '127.0.0.1:3101'
```

若已有业务后端密钥，`runner.env` 必须使用同一值；如果新生成密钥，需同时更新业务后端并重启它。升级代码或镜像时不要无故重新生成密钥，也不要把密钥内容贴进日志、工单或聊天。服务启动后，以 `qfli-runner` 执行下面的检查；此处密钥由本账号私有的、只含上述两个简单赋值的 `runner.env` 加载，命令历史不会保存密钥正文。

```sh
set -a
. "$HOME/.config/qfli-terminal/runner.env"
set +a
curl --silent --show-error --include \
  --header "Authorization: Bearer $QFLI_TERMINAL_SECRET" \
  http://127.0.0.1:3101/health
unset QFLI_TERMINAL_SECRET QFLI_TERMINAL_IMAGE
```

应返回 200 和 `"ready":true`；未带密钥会返回 401。检查时密钥会短暂出现在本机 `curl` 进程参数中，请只在专用执行账号上运行，不要把命令执行跟踪或调试输出公开。

服务精确监听 `127.0.0.1:3101`。内部请求使用独立共享密钥，App 永远拿不到该密钥。不要经公网代理暴露执行服务；单独 VM 部署需经过 TLS 反向代理，只允许业务服务器的来源地址，反向代理仍转发到执行 VM 本地 `127.0.0.1:3101`。业务配置中的 HTTPS 证书必须可校验，不得关闭 TLS 校验。

### 6. 连接业务后端

在原业务后端 `.env` 增加：

```dotenv
QFLI_TERMINAL_URL=http://127.0.0.1:3101
QFLI_TERMINAL_SECRET=与runner.env相同的独立内部密钥
```

业务账号只获得这个内部密钥，不获得执行账号权限或 Docker socket。使用专用执行 VM 时，URL 改成经过有效证书保护且只允许业务来源访问的内部 HTTPS 地址。启动新版业务后端；先解决既有数据库目录迁移冲突。没有配置执行地址时终端接口返回不可用，不回退到宿主执行。

若 App 提示“无法连接安全终端服务，已禁止宿主机执行”，表示业务后端转发请求时无法连接上述地址。先在执行服务机器检查 `systemctl --user status qfli-terminal.service` 与 `journalctl --user -u qfli-terminal.service -n 100 --no-pager`，再从业务后端所在机器访问其配置的 `QFLI_TERMINAL_URL/health`。本机部署应看到服务监听 `127.0.0.1:3101`；跨机器部署时 `127.0.0.1` 会指向业务机器，必须使用受来源限制的内部 HTTPS 地址。健康检查也需要 `Authorization: Bearer <QFLI_TERMINAL_SECRET>`；返回 401 表示两端密钥不一致，503 表示执行服务尚未就绪。业务后端日志中的 `terminal.dispatch_failed.networkCode` 可区分连接拒绝、DNS 和超时。密钥一致且健康检查为 200 后，重启业务后端使新环境变量生效。

| 现象 | 先检查 |
| --- | --- |
| `ECONNREFUSED`，`ss` 没有 `:3101` | 执行服务未监听；检查专用账号的 unit、`runner.env`、镜像及启动日志。 |
| root 下 `systemctl --user` 报无法连接 bus | 切换到 `qfli-runner` 并设置其 `/run/user/<UID>` 环境；不要查 root 的用户服务。 |
| Docker 列出 `runsc`，但 `/usr/local/bin/runsc` 不存在 | 仅注册了运行时名称；按上文安装完整 gVisor 包并重启专用 Docker。 |
| `CgroupVersion=1` 或 `/sys/fs/cgroup` 为 `tmpfs` | 宿主仍为 cgroup v1；执行服务不能在此状态启动，需先启用 cgroup v2 并重启宿主。 |
| `systemd version 239 not supported` | 服务器仍在运行旧的 `runsc` 参数；停止旧服务，上传新版目录，重跑安装器迁移 rootless Docker 配置并检查账号限额。 |
| `No such image: qfli-terminal-sandbox:2` | 以 `qfli-runner` 构建新版镜像，确认使用同一个 rootless Docker socket。 |
| `Rootless mode not supported with "create"` | 旧配置给 `runsc` 传了 `--rootless=true`；停止重启中的终端服务，上传新版目录并重跑安装器迁移专用 Docker 配置。 |
| `compression cannot be enabled when max file count is 1` | 专用 Docker 的 `local` 日志驱动需配置 `"compress":"false"`；新版安装器会迁移旧配置。 |
| 携带内部密钥访问 `/health` 返回 401 / 503 | 分别检查两端内部密钥是否一致 / 执行服务初始化日志和隔离前置条件。 |

部署完成前按“账号、cgroup v2、gVisor、rootless Docker、镜像、密钥、unit、健康检查、业务转发”的顺序逐项确认。不要用宿主 Shell 或普通 `runc` 绕开未完成的步骤。

每个专用执行账号及其 Docker engine 只能运行一个执行服务实例。使用这里的 systemd 服务，不使用 PM2 cluster，也不让不同网络命名空间的副本共享同一个 daemon。固定本地监听端口会在孤儿容器对账之前占用，以防同一宿主上的第二个实例误删仍在运行的会话。

### 7. 云项目存储边界

云项目的每用户默认限额为 256 MiB、5000 文件、50 项目，同时限制目录扫描数量，并在剩余空间低于 1 GiB 或 10% 时拒绝继续写入。这些账号级限制不能阻止大量账号累积占满共享磁盘。云存储应使用单独、有硬容量上限的磁盘或卷，为数据库、业务日志与操作系统保留独立存储空间。将真实文件系统挂载到业务配置的云存储根目录，不使用 symlink 绕过路径检查。

业务反向代理应限制终端、上传和文件扫描相关请求的频率、上传速率及并发；结合业务账号限制与网关认证，避免单个用户或大量账号占满磁盘 I/O。执行沙箱本身不挂载云项目目录，云项目的持久存储配额由业务后端另行管理。

## 上线验收与故障恢复

实际运行证据与宿主范围见 [验收记录](docs/runtime-validation.md)。WSL 下的验证不能代替生产 ECS 内核、网络及业务转发验收。公开入口开放前，管理员必须在目标机器确认：

1. 启动检查成功，日志确认 Linux/rootless/cgroup v2/seccomp/runsc、可信 image ID、单会话容量和账号级实际 cgroup 限额。
2. 沙箱 inspect 中 rootfs 只读、无 privileged/host namespaces/宿主 mounts、network none、capabilities 全移除，监督进程为 uid 65533、用户命令为 uid 65532；`/proc/<沙箱 PID>/cgroup` 必须落在 `user-<UID>.slice` 下，账号实际 `cpu.max` 不超过 1 核、`memory.max` 不超过 1 GiB、`memory.swap.max` 为 0、`pids.max` 不超过 1024。磁盘由 tmpfs 实际大小限制。
3. 普通命令可运行；后台进程不能跨命令存活；区分并验证账号宿主 `pids.max` 与 guest `nproc=64:64`，包括进程/线程风暴和 PID 1 兜底退出；输出超额、命令超时、客户端断开、进程超额或被观察到的 OOM 后会话被销毁；服务启动时清理带专用所有权标签的遗留容器。
4. 用户无法联网、读取宿主业务目录或获取业务环境变量；多个用户的工作区互不访问；重置会丢失会话文件，云项目文件不受影响。
5. 验证单执行槽、1 份会话容量、FIFO 8 条等待/20 秒期限及每用户互斥；创建/执行后清理仍占执行槽，等待不预留沙箱。验证位置更新、等待超时、断开、重置及关闭移除等待项。会话已满或队列已满分别拒绝；Docker 故障或删除失败时进入不可执行状态，不把未清理资源视为已释放。
6. 验证所部署 gVisor 的 PID 命名空间 init 语义：用户进程不能 SIGSTOP 暂停 PID 1 或通过 ptrace、proc mem、process_vm 修改 PID 1/helper，清理进程不同 GID 与不可转储保护确实生效。无法满足时禁止开放终端，不能用宿主 Yama 默认值代替该验证。
7. 验证直接耗尽内存的命令，以及“子进程耗尽内存后被杀、Shell 忽略退出结果继续返回 0”两种 OOM 情况。核对实际内存上限、guest 程序行为、`State.OOMKilled` 和 `memory.events`；观察到 OOM 时必须回收，无法观察到的 guest OOM 应记录为该运行时的验收限制，不能宣称已完整覆盖。

上述是目标部署环境的上线验收要求，不能以 `node --check` 或 Python 语法检查代替。日志包含事件与会话管理失败阶段，不应把内部密钥、用户完整脚本或输出写入业务访问日志。

若 Docker 的创建管理请求超时，daemon 可能在客户端超时之后才完成创建。执行服务在 `/run/user/<UID>/qfli-terminal-pending/` 保留未确认创建标记，关闭新执行，并在后续自动重启时拒绝启动，避免超出容量。此种状态不要直接清除标记或手工清空服务计数；先关闭业务入口，停止执行服务，重启该账号的 rootless Docker，清理确认带专用所有权标签的孤儿容器，然后清除对应标记，再启动执行服务。以下以执行账号运行，删除范围限定为该服务专用标记目录，不删除云项目或旧终端文件：

```sh
systemctl --user stop qfli-terminal.service
systemctl --user restart docker.service
docker ps -a --filter label=io.qfli.terminal.owner=qfli-terminal-v1
docker ps -aq --filter label=io.qfli.terminal.owner=qfli-terminal-v1 | xargs -r docker rm -f
docker ps -aq --filter label=io.qfli.terminal.owner=qfli-terminal-v1
# 上一条必须无输出，且无 Docker 错误，再执行：
find "$XDG_RUNTIME_DIR/qfli-terminal-pending" -maxdepth 1 -type f -name 'qfli-*' -print
# 核对该专用目录及文件后再清除标记：
find "$XDG_RUNTIME_DIR/qfli-terminal-pending" -maxdepth 1 -type f -name 'qfli-*' -delete
systemctl --user start qfli-terminal.service
journalctl --user -u qfli-terminal.service -n 100 --no-pager
```

确认健康后才恢复入口。宿主重启会清空 `/run/user/<UID>` 与内存工作区；执行服务仍须检查并清理 Docker 中的专用遗留容器。

普通重启也会清空终端会话，属于设计行为。回滚只能关闭终端能力或恢复上一版经过审核的隔离服务，禁止回滚到曾直接执行宿主命令的终端实现。升级时维护独立执行密钥、镜像版本和 gVisor 版本记录。

# CI 平台对照

本仓库托管在 CNB、GitHub、GitLab、Gitee 与 GitCode。
校验与构建逻辑统一放在 `scripts/ci-common.mjs`。
各平台只负责检出代码、准备 Node 与登录镜像仓库。

## 总览

| 平台 | 校验 | 发布镜像 | 执行器 / 沙箱镜像地址 | 配置文件 |
| --- | --- | --- | --- | --- |
| CNB | 有 | 有 | `docker.cnb.cool/azurekiln/azurekiln-qfli-terminal` 与 `.../sandbox` | `.cnb.yml` |
| GitHub | 有 | 有 | `ghcr.io/azurekiln2333/azurekiln-qfli-terminal` 与 `.../sandbox` | `.github/workflows/build-and-push.yml` |
| GitLab | 有 | 有 | `registry.gitlab.com/azurekiln-team/azurekiln-qfli-terminal` 与 `.../sandbox` | `.gitlab-ci.yml` |
| Gitee | 无 | 无 | 无 | 无 |
| GitCode | 有 | 无 | 无 | `.gitcode/workflows/verify.yml` |

## CNB

`.cnb.yml` 读取 `CNB_REPO_SLUG_LOWERCASE`、`CNB_COMMIT` 与 `CNB_BRANCH`。
`services: [docker]` 自动登录 `docker.cnb.cool`，发布步骤传入 `--no-login`。
每个执行 Node 脚本的任务都固定使用 `node:24.15.0-bookworm`。

## GitHub Actions

工作流固定 `actions/checkout` 与 `actions/setup-node` 提交哈希。
`verify` 只有 `contents: read` 权限，拉取请求不会登录或推送镜像。
`image` 任务额外申请 `packages: write`，用 `github.token` 登录 `ghcr.io`。
构建与标签提升拆分执行，方便在日志中区分构建、冒烟或推送失败。

## GitLab CI

`.gitlab-ci.yml` 读取 `CI_REGISTRY`、`CI_REGISTRY_PATH`、`CI_REGISTRY_USER` 与 `CI_REGISTRY_PASSWORD`。
发布任务使用 `docker:dind` 服务并安装 `bash`、`nodejs` 与 `python3`。

## Gitee：不加工作流

个人免费仓库不提供提交触发的 GiteeGo 托管流水线，因此不加 `.workflow/`。

## GitCode / AtomGit：只加校验

托管镜像仓库缺少公开凭据说明，因此只保留只读校验工作流。

## 服务器拉取

生产机默认跟踪 CNB 镜像。
切换到 GHCR 时修改 `bootstrap.sh` 参数或 `.env`，不改动 `docker-compose.yaml`：

```sh
# .env 覆盖示例
QFLI_TERMINAL_IMAGE=ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:3
QFLI_TERMINAL_SERVICE_IMAGE=ghcr.io/azurekiln2333/azurekiln-qfli-terminal:latest
```

直接使用安装器拉取 GHCR：

```sh
bash /root/qfli-terminal-bootstrap.sh \
  --source-dir /实际上传目录/azurekiln-qfli-terminal \
  --business-env /实际业务后端目录/.env \
  --executor-image ghcr.io/azurekiln2333/azurekiln-qfli-terminal:latest \
  --sandbox-image ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:3
```

## 标签约定

- 分支 `main`：执行器推送 `sha-<12位提交>` 与 `latest`，沙箱推送 `sha-<12位提交>`、`3` 与 `latest`。
- 标签 `vX.Y.Z`：执行器推送 `vX.Y.Z` 与 `latest`，沙箱推送 `vX.Y.Z`、`3` 与 `latest`。
- 预发布 `vX.Y.Z-rc.1`：执行器推送同名标签，沙箱推送 `vX.Y.Z-rc.1-sandbox`，两者都不移动 `latest` 或 `3`。

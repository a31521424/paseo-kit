# paseo-kit

[English](README.md) | 简体中文

[Paseo](https://paseo.sh) 插件合集。每个插件位于 `plugins/<id>/`，是一个完整、独立的 Paseo 插件项目。

## 插件

| ID | 名称 | 功能 |
| --- | --- | --- |
| [`host-monitor`](plugins/host-monitor) | Host monitor | 在侧边栏底部显示 daemon 主机的 CPU、内存和网速，点击查看历史曲线。 |
| [`ccusage-stats`](plugins/ccusage-stats) | Token usage | 基于 [ccusage](https://github.com/ccusage/ccusage) 统计编码 agent 的 token 消耗与估算费用：今日总量、按日/周/月分 agent 分析、当前 session 消耗。 |

### host-monitor

- 侧边栏底部一行：CPU、内存百分比与小进度条，下载 / 上传速度。
- 超过 70% 变黄，超过 90% 变红；侧边栏较窄时先隐藏网速。
- 弹出层展示每项指标约三分钟的历史、运行时间和负载。
- daemon 每 2 秒采样一次，历史保存在内存中。网速仅支持 Linux。

### ccusage-stats

- 侧边栏底部一行：今日 token 总量、按 agent 拆分的条形图、估算费用。
- 弹出层：日 / 周 / 月总量、与上一周期的对比、堆叠柱状图。
- 完整的 **Token usage** 页面（也可从 Command Center 打开）：30 天 / 12 周 / 12 个月历史、每百万 token 成本、缓存命中率、按 agent 和模型拆分、最近的 session。
- 每个 agent 的输入框上方有一个 pill，显示当前 provider session 的 token 总量。
- 统计 ccusage 支持的所有 agent（Claude Code、Codex、Gemini CLI、OpenCode、Amp 等）。费用为按 API 标价离线估算，不向外发送任何数据。

详细说明与限制见各插件的 `OVERVIEW.md`。

## 环境要求

- Paseo **0.11.1** 及以上（daemon 和 app）。
- daemon 已开启插件：**Settings → Plugins → Enable plugins**，或在 daemon 的 `config.json` 中设置 `"pluginsEnabled": true` 后执行 `paseo reload`。
- daemon 主机上有 Node.js 和 npm（用于安装依赖）。

## 安装

### 从 GitHub 安装

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/host-monitor
paseo plugin install github:a31521424/paseo-kit:plugins/ccusage-stats
```

`ccusage-stats` 在 manifest 中声明了 `build: [["npm", "ci", "--omit=dev"]]`，Paseo 会按锁文件安装内置的 ccusage 二进制。`host-monitor` 只用 Paseo 提供的库。之后用 `paseo plugin update <id>` 更新。

### 从本地克隆安装

```bash
git clone https://github.com/a31521424/paseo-kit.git
cd paseo-kit
npm run install:all

paseo plugin install "$PWD/plugins/host-monitor"
paseo plugin install "$PWD/plugins/ccusage-stats"
paseo plugin ls
```

目录插件直接从源码目录加载。移动仓库位置后，需要先 `paseo plugin remove <id>`，再按新的绝对路径重新安装。

## 开发流程

```bash
npm run typecheck              # 检查全部插件；也可在 plugins/<id> 内单独执行
paseo plugin reload <id>       # 加载源码改动
paseo plugin ls                # 状态应为 running 且无错误
paseo plugin logs <id>         # 查看插件 daemon 子进程的输出
```

不要为了加载插件改动而重启 daemon。`paseo plugin reload <id>` 即可，重启会杀掉正在运行的 agent。

客户端代码需同时适配桌面端和移动端：只用 React Native 原生组件，文字颜色取自 `theme.colors`，间距根据 `layout.compact` 调整。用下面的命令审计：

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" plugins/*/client/
```

`useState<number | null>` 这类 TypeScript 泛型也会命中，可忽略；`client/web.ts` 以外的其他命中都是 bug。

### 目录结构

```text
paseo-kit/
  package.json            仅含根脚本：install:all、typecheck
  plugins/
    <id>/
      paseo-plugin.json   manifest：id、name、description、requirements.paseo
      OVERVIEW.md         Paseo 内展示的插件介绍页
      package.json
      package-lock.json
      tsconfig.json
      index.client.tsx    app 入口
      index.server.ts     daemon 入口
      client/  server/  shared/
```

本仓库刻意**不使用** npm workspaces，每个插件在 `plugins/<id>/node_modules` 中独立安装依赖。`ccusage-stats` 会在自身插件目录下查找 ccusage 原生二进制，依赖提升到根目录会导致找不到。

### 新增插件

```bash
paseo plugin init "$PWD/plugins/<id>"
cd plugins/<id>
npm install
```

然后与现有插件对齐：相同的 `@getpaseo/plugin` 版本和 `requirements.paseo` 范围、相同的 `tsconfig.json`、`package.json` 的 `name` 与 ID 一致，并写一份如实的 `OVERVIEW.md`。最后把它加到上方插件表和 `.github/workflows/typecheck.yml` 的 CI 矩阵中。

## 信任与安全

Paseo 插件是**受信任、无沙箱**的代码。服务端代码作为 daemon 子进程运行，可完全访问 daemon 主机的文件、进程、凭据和网络；客户端代码运行在 Paseo app 内。安装任何插件（包括本仓库的插件）前请先阅读源码。不要提交凭据，也不要在插件代码中打印凭据。

## 许可证

[MIT](LICENSE)

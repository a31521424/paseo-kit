# 更改说明：file-download 与 tab-recovery 插件

本文说明 paseo-kit 新增的两个插件，用来改善 Paseo 的体验问题。原仓库不太接收社区贡献，所以全部通过插件实现，不修改 Paseo 本身。

状态：已实现，已安装到本机 daemon（0.11.2），后台接口和网页端都已测试，见第 7 节。移动端不在范围内。

调研引用的 Paseo 源码：`getpaseo/paseo` main 分支 `4117dce`（2026-10-16），以及与本机版本一致的 `v0.11.2` 标签。行号以 main 分支为准。

## 1. 问题与范围

| # | 问题 | 处理方式 |
| --- | --- | --- |
| 1 | agent 写的临时文件能预览但难下载；下载只在文件树里 | 新插件 `file-download`：预览文件时按 Cmd+S / Ctrl+S 下载当前文件 |
| 2 | 预览能力弱，不清楚视频、图片能否预览 | 调研结论见 2.2；按最小方案不在插件里另做预览 |
| 3 | 快捷键误关标签页后无法恢复 | 新插件 `tab-recovery`：列出本工作区被关闭的 agent，一键恢复并重新打开标签 |

不做：`/download` 斜杠命令、任何界面按钮、主动发现文件、批量下载、按路径下载、移动端。

## 2. 调研结论（现状）

### 2.1 下载

- 下载入口只在文件树和 git diff 的右键菜单（`app/src/components/file-actions-menu.tsx:187-195`），一次一个文件，文件夹没有下载项，也没有打包。
- 文件预览标签的标题栏（`app/src/file-pane/bar.tsx`）没有下载按钮。
- 下载接口按工作区根目录校验路径，`/tmp/foo.png` 这类工作区外的文件会被拒绝（`server/src/server/file-explorer/service.ts:534-541`、`808-831`）。
- 预览能打开工作区外的文件，是因为预览会把 cwd 换成 `/` 或 `~`（`app/src/file-explorer/preview-target.ts:60-107`），下载没有这样做。

### 2.2 预览

| 类型 | 内置支持 |
| --- | --- |
| 代码、文本 | 支持，网页端 1 MB 以内可编辑 |
| Markdown、HTML | 支持，可在预览和源码间切换 |
| 图片 | 仅 `.png .jpg .jpeg .gif .webp .svg`，可缩放 |
| 视频、音频、PDF | 不支持，显示 "Binary preview unavailable" 和文件大小 |
| 大小上限 | 网页和桌面 50 MB，移动端 10 MB |

依据：`app/src/file-pane/pane.tsx:133-232`、`server/src/server/file-explorer/service.ts:117-124`、`app/src/file-pane/source/presentation.ts:1-4`。

### 2.3 关闭标签页

- `Cmd+W`（macOS）、`Ctrl+W`（Windows/Linux 桌面）、`Alt+Shift+W`（网页）关闭当前标签（`app/src/keyboard/keyboard-shortcuts.ts:501-532`）。
- 对主 agent 标签，关闭等于**在服务端归档该 agent 并关闭其运行时**（`app/src/subagents/close-tab-policy.ts:5-13`、`app/src/screens/workspace/workspace-screen.tsx:1984-2056`）。子 agent 只是隐藏。
- 只有 agent 正在运行时才弹确认，空闲时直接归档，没有设置项可开启确认（`workspace-screen.tsx:1995-2008`）。
- 没有"重新打开已关闭标签"、撤销提示或工作区内的已归档列表。
- 内置恢复路径：侧边栏 **History** → 点击带 "Archived" 标记的 agent（以 pin 方式打开，`app/src/components/agent-list.tsx:364-381`）→ 点标签里的 **Unarchive**。

### 2.4 插件能力边界

- 插件不能给内置文件预览、文件树右键菜单或标签页加按钮，也不能打开内置的文件预览标签（`openPanel` 只能打开插件自己的面板）。
- 插件 SDK 没有文件读取或下载接口，但插件后台是普通 Node 子进程，可以直接用 `node:fs` 读任意路径。
- 插件 SDK 没有解除归档的接口。`navigation.openAgent` 不带 pin（`app/src/plugins/host-navigation.ts:19`）。
- Command Center 回调拿不到 `navigation`，只有屏幕和面板能拿到。
- 提示框（`useToast`）不支持操作按钮，做不了"撤销"。
- 单条 websocket 消息上限：直连 100 MB，经中转 32 MB（`protocol/src/websocket-message-limit.ts`），大文件必须分块传输。

## 3. 变更总览

| 路径 | 变更 |
| --- | --- |
| `plugins/file-download/` | 新增插件 |
| `plugins/tab-recovery/` | 新增插件 |
| `README.md`、`README.zh-CN.md` | 插件表格、功能说明、依赖表、安装提示词和安装命令 |
| `package.json` | `description` 加上两个新插件 |
| `.github/workflows/typecheck.yml` | CI 矩阵加上两个新插件 |

两个插件都只使用 Paseo 提供的模块和 Node 内置模块，没有运行时 npm 依赖，manifest 不需要 `build` 步骤。`requirements.paseo` 与现有插件一致为 `>=0.11.1`。界面文字与仓库现有插件一致，使用英文。

### 3.1 方案演进

`file-download` 最初是 `agent-files`：读 agent 对话记录主动发现文件、多选打包 ZIP、图片网格与视频/音频/PDF 预览、监视目录、头部"⬇ N"按钮。实现并测试后，按讨论收敛为最小方案：

- 入口只保留快捷键和命令面板；评估过的头部按钮、预览工具栏内插标签、输入框上方标签都不做。
- 下载历史只记录用户主动发起的下载，不主动发现文件。
- 删除批量下载、ZIP、预览、监视目录、设置页和按路径下载。

## 4. 插件 `file-download`

名称 **Download file**。

### 4.1 入口

| 入口 | 行为 |
| --- | --- |
| `Cmd+S`（macOS）/ `Ctrl+S`（Windows、Linux） | 当前聚焦的是文件预览标签：下载该文件，并提示开始与完成。其他标签（如 agent）：静默，不提示、不下载，也不弹浏览器的保存网页对话框 |
| 命令面板 "Download current file" | 同上；不是文件时由 Paseo 弹出命令错误提示 |
| 命令面板 "Open downloads" | 打开下载历史面板（工作区标签，也可放进 Explorer 侧栏） |

平台按浏览器报告的操作系统判断，Mac 上的浏览器同样用 Cmd。只在网页端和桌面版注册。

### 4.2 判断当前文件

插件 API 读不到聚焦的标签，所以读取 Paseo 存在本地存储里的标签布局：

1. 从网址 `/h/<服务器ID>/workspace/<工作区ID>` 得到当前工作区。桌面版加载 `paseo://app/<路由>`，路径相同。
2. 读 `localStorage["workspace-layout-state"]`，取 `layoutByWorkspace["<服务器ID>:<工作区ID>"]`，沿 `root.group.children[].pane` 找到 `focusedPaneId` 对应面板的 `focusedTabId` 标签。
3. 标签 `target.kind === "file"` 时取 `target.path`。路径可能是绝对路径、`~/` 开头或相对工作区目录，由后台解析。

只在按键或执行命令时读取一次，不轮询。格式读不懂时按"不是文件"处理：快捷键静默，命令提示。

### 4.3 快捷键边界

- 事件已被处理（`defaultPrevented`）时跳过：Paseo 文件编辑器的 `Mod-s` 会先处理，所以光标在编辑器里时仍是保存修改。
- 在工作区页面内（无论是否文件）都阻止浏览器默认的"保存网页"，保证非文件标签上完全静默；不在工作区页面时不拦截。
- 多主机：后台读 `$PASEO_HOME/server-id`（或 `PASEO_SERVER_ID`）返回服务器 ID，只有与网址中服务器 ID 一致的那份插件响应。

### 4.4 提示

- 命令：抛出错误，Paseo 自己的命令错误提示会显示。
- 快捷键：只在文件标签上提示下载开始、完成和失败；非文件标签静默。快捷键不在任何组件里，无法直接用 `useToast`，所以插件注册一个侧边栏底部项 "Download notices"，组件只订阅消息、调用 `useToast`，不渲染任何内容。实测左侧边栏收起后它仍在运行。

### 4.5 下载与历史

- 后台 `download.open` 校验路径是存在的普通文件、不超过 1 GB；`download.read` 按 4 MB 分块以 base64 返回；`download.close` 结束。闲置 10 分钟的传输自动清理。
- 前端拼成 Blob，用 `<a download>` 保存（`client/web.ts`）。
- 历史只存在当前页面内存里，刷新后清空。每条显示文件名、目录、所属工作区、状态（下载中百分比 / 完成大小与时间 / 失败原因）；可再次下载、复制路径、移除；顶部 "Clear" 清掉已结束的记录。

### 4.6 RPC 合约（`shared/download.ts`）

| 名称 | 输入 | 输出 |
| --- | --- | --- |
| `download.host` | `{}` | `{ serverId }` |
| `download.open` | `{ workspaceId, path }` | `{ transferId, name, size }` |
| `download.read` | `{ transferId, offset }` | `{ base64, nextOffset, done }` |
| `download.close` | `{ transferId }` | `{}` |

安全：后台接受任意路径，读取范围与 Paseo 自带预览一致（预览本身可读取主机上的任意文件），没有扩大权限。

### 4.7 目录结构

```text
plugins/file-download/
  paseo-plugin.json  OVERVIEW.md  README.md  package.json  package-lock.json  tsconfig.json
  index.client.tsx       快捷键、两个命令、历史面板、提示组件
  index.server.ts        服务器 ID、路径解析、RPC 处理
  client/
    downloads.ts         下载流程、历史记录、提示消息
    history-panel.tsx    下载历史面板
    notice-host.tsx      不可见的提示组件
    web.ts               快捷键、读标签布局、保存文件（唯一接触浏览器全局对象的文件）
    format.ts            大小、时间、百分比
  server/transfers.ts    单文件分块传输
  shared/download.ts     RPC 合约
```

## 5. 插件 `tab-recovery`

名称 **Closed agents**。

### 5.1 入口

- 工作区面板 `closed`：`locations: ["workspace", "explorer"]`，图标 `ArchiveRestore`。
- Command Center 工作区项 **Reopen a closed agent**，打开该面板。

### 5.2 列表

- 后台 `agents.closed({ workspaceId })`：已归档、属于该工作区、没有 `paseo.parent-agent-id` 标签（即主 agent）的 agent，按归档时间倒序，最多 50 个。
- 面板每 5 秒刷新，每行显示标题、关闭时间、provider 和模型。

### 5.3 恢复

1. 用户点击某行，客户端调用 `agents.restore({ workspaceId, agentId })`。
2. 后台先确认该 agent 仍在本工作区的已关闭列表里，避免重启仍在运行的 agent。
3. 后台运行 `paseo agent reload <id> --json`。它发送的请求与内置 Unarchive 按钮相同：解除归档并恢复 provider 会话。CLI 通过继承的 `PASEO_HOME` 找到本 daemon。
4. 客户端等 `useAgent` 显示该 agent 状态不再是 `closed`，再调用 `navigation.openAgent` 打开标签；15 秒内没等到则提示用户从侧边栏打开。

前提：daemon 的 PATH 中有 `paseo` CLI；找不到时给出明确错误。

### 5.4 不做

- 拦截快捷键、关闭前确认：插件没有对应能力。
- 带"撤销"按钮的提示：提示框不支持操作按钮。

OVERVIEW 中写明了不装插件时的办法：History 恢复，以及在快捷键设置中改绑或取消 "Close current tab"。

### 5.5 目录结构

```text
plugins/tab-recovery/
  paseo-plugin.json  OVERVIEW.md  README.md  package.json  package-lock.json  tsconfig.json
  index.client.tsx       面板与 Command Center 项
  index.server.ts        RPC 处理
  client/closed-panel.tsx
  server/agents.ts       列出已关闭 agent、调用 paseo agent reload
  shared/agents.ts       RPC 合约
```

## 6. 风险与限制

| 项 | 影响 | 处理 |
| --- | --- | --- |
| 依赖 Paseo 未公开的标签布局格式 | 升级后可能读不到当前标签 | 读不懂时快捷键静默、命令提示"不是文件"，不报错 |
| 提示依赖侧边栏底部的空组件 | 用户在侧边栏设置中隐藏它后，快捷键没有提示（下载照常） | OVERVIEW 写明 |
| 浏览器内存 | 文件在浏览器内存中拼接 | 单个文件上限 1 GB |
| 连着多个主机时不在工作区页面 | 每个主机的插件都可能提示一次 | 罕见，接受 |
| 恢复依赖 `paseo` CLI（tab-recovery） | PATH 中没有 CLI 时无法恢复 | 报错说明原因 |

## 7. 验证记录

本机 daemon 0.11.2，网页端用 Chromium headless shell 打开 `app.paseo.sh` 0.11.4 直连本机 daemon（Linux，快捷键为 Ctrl+S）。

file-download：

- `npm run typecheck` 通过，CI 用的客户端审计无命中，`paseo plugin ls` 为 `running`；所用 Lucide 图标均存在。
- 预览 `/tmp/agent-files-demo/demo-report.md` 时按 Ctrl+S：浏览器产生下载，内容与原文件逐字节一致，出现 "Downloaded demo-report.md" 提示。
- 预览工作区内的 `README.md`（标签里是相对路径）时按 Ctrl+S：下载内容与工作区文件一致。
- 在 agent 标签按 Ctrl+S：不下载，也没有任何提示（按要求静默）。
- 命令 "Download current file"：在 agent 标签上弹出同样的错误提示；在文件标签上正常下载。
- 切到 Source 模式、光标在编辑器里按 Ctrl+S：插件不下载（由编辑器处理保存）。
- 收起左侧边栏后提示组件仍在运行（当时用非文件标签的提示验证；该提示现已按要求去掉，文件下载提示走同一通道）。
- "Open downloads"：列出本页面内的下载；再次下载产生新下载和新记录；移除、Clear 正常。

tab-recovery：

- 建了一个临时 agent 并归档。`agents.closed` 列出了它，已归档状态为 `closed`。`agents.restore` 后 `archivedAt` 为 null、状态 `idle`，用时约 1.6 秒。传错工作区或恢复已活跃的 agent 都会被拒绝。
- 网页端：用关闭标签快捷键（`Alt+Shift+W`）关闭测试 agent，它出现在 Closed agents 面板；点 Reopen 后 agent 恢复、标签重新打开、历史完整、输入框可用；刷新页面后标签仍在。测试 agent 已删除。

仍未验证：

- 桌面版（Electron）中的快捷键与下载保存。
- macOS 上的 Cmd+S（headless 环境是 Linux）。

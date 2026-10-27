# host-monitor：修复 issue #1 并申请更新 registry 收录

## 1. 问题判断

Issue: https://github.com/a31521424/paseo-kit/issues/1

| 报告项 | 判断 | 依据 |
| --- | --- | --- |
| macOS RAM 显示 93%，并且标红 | **成立，是 bug** | `server/sampler.ts` 在非 Linux 平台用 `os.totalmem() - os.freemem()` 计算。macOS 的 `freemem` 只统计完全空闲的页，cached files（file-backed 页和 purgeable 页）都被算成已用。颜色阈值固定在 70% 和 90%，于是缓存很大的 Mac 会一直显示红色，看起来像内存紧张。 |
| 按 1024 换算却标成 KB/MB/GB | **成立，是 bug** | `client/format.ts` 除以 1024，单位却写 `KB/MB/GB/TB`：994,610,155,520 字节被显示成 "926.3 GB"，正确写法是 926.3 GiB 或 994.6 GB。 |
| APFS 磁盘显示 62%，别的 App 显示 58% | **不是计算错误，口径没写清楚** | macOS 上 `statfs('/')` 返回整个 APFS container 的总量和剩余空间，"已用"包含 container 里所有卷。issue 也只要求加一句说明，没有要求改口径。 |
| CPU 10% 和 12% 的差异 | 不是问题 | issue 自己也说明了，两次采样时间不同。 |

## 2. 修复内容（commit 14e6ac0，已 push 到 main）

- **macOS 内存口径**（`server/sampler.ts`）：每 2 秒运行一次 `/usr/bin/vm_stat`，用 Activity Monitor 的 "Memory Used" 口径计算：
  `used = (Anonymous - Purgeable) + Wired + Occupied by compressor`，
  `cached = File-backed + Purgeable`。
  调用方式是 `execFile`，不经过 shell，路径和参数都是固定的，超时 1.5 秒。`vm_stat` 失败时退回原来的 `freemem` 算法。macOS 上第一个 sample 会等 `vm_stat` 返回再生成，避免历史曲线开头出现一个虚高点。
- **按内存压力着色**：同时读取 `sysctl -n kern.memorystatus_vm_pressure_level`（1 = normal，2 = warning，4 = critical）。macOS 上 RAM 的颜色只看压力等级，不再看百分比。Linux 和 Windows 仍按 70%/90% 阈值着色（Linux 本来就用 `MemAvailable`，不受缓存影响）。
- **RPC schema**（`shared/stats.ts`）：`memory` 增加两个字段 `cachedBytes` 和 `pressure`，非 macOS 平台为 `null`。
- **Popover**：RAM 行下方增加一行 "Cached files 18.5 GiB · pressure normal"（仅 macOS）。macOS 的磁盘行增加 "APFS container: all volumes sharing it"。
- **单位**：改为 IEC 单位 `KiB/MiB/GiB/TiB`，换算仍按 1024，RAM 和磁盘统一使用。
- **布局**：sidebar 的紧凑 CPU/RAM/Disk/网络一行布局没有改动（issue 明确要求保留）。
- **OVERVIEW.md**：说明 macOS 的内存口径、压力着色、二进制单位和 APFS container 口径；披露 macOS 上会运行的两条命令。

## 3. 与官方收录版本的 diff

收录记录：`getpaseo/plugins` 中的 `plugins/a31521424/host-monitor.json`，pin 在 `d3a502c33e8842ffc2650418427996bc4bdd5ca5`，于 2026-10-13 审核通过（PR #374）。

`git diff --stat d3a502c -- plugins/host-monitor`：

```
 plugins/host-monitor/OVERVIEW.md        |   6 +-
 plugins/host-monitor/client/format.ts   |   5 +-
 plugins/host-monitor/client/sidebar.tsx |  85 ++++++++++++++++++----
 plugins/host-monitor/client/stats.tsx   |  45 ++++++++++--
 plugins/host-monitor/index.server.ts    |   9 +++
 plugins/host-monitor/server/sampler.ts  | 123 +++++++++++++++++++++++++++++---
 plugins/host-monitor/shared/stats.ts    |  14 +++-
 7 files changed, 253 insertions(+), 34 deletions(-)
```

改动分两部分：

1. **已在 main 上（`3d8a3df`）**：`index.server.ts` 增加 `v8.setFlagsFromString("--no-maglev")`。原因是插件进程里有一个约 11 MB 的生成校验函数，Maglev 编译它时 RSS 会冲到接近 1 GB。
2. **本次修复（第 2 节）**：其余 6 个文件。

审核时需要关注的变化：

- **新增 subprocess**：只在 macOS 上运行 `/usr/bin/vm_stat` 和 `/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level`，用 `execFile` 调用，不经过 shell，路径和参数都是固定的，有超时。旧版本没有任何 subprocess，所以上一次审核记录里写的是 "no subprocess"，这次 reviewer 会重新评估这一项。OVERVIEW 已经披露了这两条命令。
- 新增的 `v8.setFlagsFromString` 只影响插件自己的进程。
- 没有新增依赖，`package.json`、`package-lock.json`、`paseo-plugin.json` 都没有改动，入口文件不变。
- RPC 只增加了两个字段，没有新增 RPC，也没有新的网络访问、文件写入或凭据读取。

## 4. 新的上架（更新）申请

registry 规定 Git 插件的更新需要手动提交：用同一个插件名开一个新的 submission issue，填上新的 commit。修复已 push 到 main，commit 为 `14e6ac03d78c7430c054894557062426acd3f2e9`。

提交地址：https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml

**Title**

```
Host monitor
```

**Source**

```
https://github.com/a31521424/paseo-kit/tree/14e6ac03d78c7430c054894557062426acd3f2e9/plugins/host-monitor
```

**Categories**

- [x] Daemon management
- [x] Sidebar

**附加说明**（表单之后作为评论补充，方便 reviewer 理解改动）：

```markdown
Update request for the existing listing `a31521424/host-monitor` (currently pinned at d3a502c).

Changes since d3a502c:

- macOS memory now follows Activity Monitor's Memory Used (app + wired + compressed, from `vm_stat`); cached files are reported separately instead of counted as used. Fixes a31521424/paseo-kit#1.
- On macOS the RAM color follows the kernel memory pressure level (`kern.memorystatus_vm_pressure_level`) rather than the percentage.
- Byte sizes use IEC labels (KiB/MiB/GiB) to match their 1024 divisor.
- The popover labels the macOS disk as the APFS container.
- The server sets `--no-maglev` for its own process, which keeps V8 from compiling the protocol's 11 MB generated validator (RSS spikes near 1 GB).

Review notes: new on macOS only, the server runs `/usr/bin/vm_stat` and `/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level` every two seconds via `execFile` (no shell, fixed paths and arguments, 1.5 s timeout). OVERVIEW.md discloses both. No new dependencies, RPCs, network access or file writes; manifest, package and lockfile are unchanged.
```

## 5. 回复 issue #1 的草稿

```markdown
Thanks for the detailed report — both points were real bugs.

- macOS RAM now uses Activity Monitor's Memory Used accounting (app memory + wired + compressor, from `vm_stat`). Cached files are no longer counted as used and are shown on their own line in the popover. The RAM color on macOS now follows `kern.memorystatus_vm_pressure_level` (yellow at warning, red at critical), not the occupied percentage.
- Sizes are labeled KiB/MiB/GiB, matching the 1024 divisor.
- The popover now labels the macOS disk as the APFS container, so the 62% vs. data-volume difference is explained in place.

The compact sidebar layout is unchanged. Fixed in 14e6ac03d78c7430c054894557062426acd3f2e9; the registry update is requested in getpaseo/plugins#1220.
```

## 6. 验证情况

- `npm run typecheck` 通过。
- `vm_stat` 解析：用一份构造的 Apple Silicon 64 GiB 输出测试，按 issue 中的 free 页数计算，旧算法得到 93.6%，新算法得到 76.0%，cached 为 11.7 GB。带引号的行（`"Translation faults"`）能正确解析，内容不合法时返回 `null`。
- 在 Linux 上把 `process.platform` 设为 `darwin`，并 stub 掉 `execFile`，跑完整个 sampler：两条命令按预期调用，`pressure` 正确映射。命令失败时退回 `freemem` 算法，`cachedBytes` 和 `pressure` 为 `null`。
- Linux 实机运行 sampler：结果和改动前一致，第一个 sample 的 CPU 仍为 0。
- **未验证**：没有在真实 macOS 上运行，也没有在 Paseo UI 里实际看渲染效果（本机 daemon 装的是 `/home/banb/paseo-kit` 主 checkout 的版本）。合并后建议在 issue 作者的 Mac 上对照 Activity Monitor 确认一次。
- 可选：`assets/screenshot.png` 里的单位还是旧的 "GB"，listing 截图可以顺便更新。

## 7. 结果

- 2026-10-26 提交 getpaseo/plugins#1220，审核 PR #1221 当天批准合并。registry 记录已 pin 到 `14e6ac03d78c7430c054894557062426acd3f2e9`，`reviewedAt` 为 `2026-10-26T11:05:33Z`。
- 审核未发现安全问题。可选建议：下个版本把截图换成 IEC 单位。
- reviewer 只做了源码审查，没有在 macOS 上运行或对比 Activity Monitor。
- paseo-kit#1 已经因提交里的 `Fixes #1` 自动关闭，修复说明和 registry 链接都回复在里面。

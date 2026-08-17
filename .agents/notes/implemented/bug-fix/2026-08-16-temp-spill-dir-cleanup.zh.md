# Agent Note: 在销毁与进程退出时删除自有临时 spill 目录

Status: implemented

[English](2026-08-16-temp-spill-dir-cleanup.md) | 中文

## Problem

每个会溢出超长工具输出或子进程输出的 DSH 进程，都会在操作系统临时目录下创建一个私有（0700）暂存目录——`@deepseek-ai/dsh-spill-local` 的默认 root 创建 `dsh-spill-*`，`@deepseek-ai/dsh-subprocess-local` 的默认 spill 位置创建 `dsh-subprocess-*`。两个目录都是惰性创建的（`mkdtempSync(join(tmpdir(), …))`），且从没有任何代码删除它们。长期运行的机器会累积成百上千个空目录或过期目录——这些按进程划分的目录纯属暂存，不是持久数据，因此每个进程退出都会多泄漏一个。

## Decision

每个 seam 现在都会在自己拥有的两条 teardown 路径上删除其临时目录：

- `@deepseek-ai/dsh-spill-local` 从 `store.ts` 导出 `removePrivateRootSync()`。仅当部署未配置 `config.root` 时，`LocalSpillStore` 才注册一个 `ctx.effect`（标签 `local spill root teardown`）：disposer 删除默认 root（优雅的 context 销毁路径），而一个 `prepend` 的 `process` `exit` 监听器再次删除它，作为跳过销毁的退出路径的同步兜底。配置的 `root` 属于部署自己的存储，永不被删除。
- `@deepseek-ai/dsh-subprocess-local` 从 `spawn.ts` 导出 `removeDefaultSpillDirSync()`。服务既有的 `exit` finalizer 在强制终止存活进程树之后删除默认 spill 目录，`disposeManagedProcesses()` 则在所有进程树都已结算（静默点）之后删除一次——这是优雅路径，因为 CLI 在退出前会先销毁应用树，因而不会走到 `exit` 兜底。

两次删除都会把模块级默认值重置为 `undefined`，因此同一进程内的后续使用（另一个 context 挂载、另一次 spawn）会创建全新目录，而不是复用被删掉的路径。每个删除守卫都拒绝穿透替换了目录的链接状路径：真实目录递归删除，其他任何东西不加遍历地 unlink；目录不存在、竞态和 Windows 文件锁一律吞掉——临时清理绝不能导致 teardown 失败。两个守卫是刻意的近似复制，因为每个 seam 独立拥有自己的暂存目录；为十几行代码抽共享模块得不偿失。

`$DSH_HOME/sessions` 下的会话持久化日志有意保持不变：它们是持久的恢复/查询记录，不是暂存数据，其保留策略属于产品决策。

## Alternatives considered

**只在 `exit` 监听器里删除目录。** 否决：CLI 的优雅关闭会先销毁应用树，在事件触发之前就注销 effect 拥有的 `exit` 监听器——正常路径将永远无法清理。两条路径缺一不可。

**只在每次 context 销毁时删除，不在进程退出时删除。** 否决：非优雅退出（崩溃、强制的 `process.exit`）会继续泄漏。

**跨包复用同一个清理 helper。** 否决：两个 seam 是独立包；为一个短函数抽取共享模块会新增一条依赖边和一个包，却没有所有权收益。

**改用操作系统临时清理器或类 cron 的清扫器。** 否决：目录在进程退出前都归活跃进程所有；后台清扫器无法可靠区分过期目录与在用目录，而所有者却确切知道自己何时用完。

**在同一改动里自动清理 `$DSH_HOME/sessions`。** 否决：会话日志是有恢复与查询价值的用户数据；保留策略属于产品，不属于泄漏修复。

## Consequences

- 正常退出的进程不再留下任何 `dsh-spill-*` 或 `dsh-subprocess-*` 目录；崩溃或被强杀的进程留下的目录仍由操作系统临时清理器回收，与之前一致。
- 配置的 spill `root` 或测试注入的 `spillDir` 永不被触碰；只删除内部创建的默认目录。
- 删除是尽力而为的：在 Windows 上打开中的 spill 文件可能导致递归删除失败，此时会被吞掉并把目录留给操作系统临时清理器。
- 测试为每个 seam 固定了两条路径：销毁删除、`exit`-finalizer 删除、非目录替换物的 unlink、目录缺失/默认值已清空的容错（`spill-local.spec.ts`、`local.spec.ts`）。

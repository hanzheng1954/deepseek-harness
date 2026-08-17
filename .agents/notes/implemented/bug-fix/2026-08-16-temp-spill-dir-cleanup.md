# Agent Note: Remove owned temp spill directories on disposal and host exit

Status: implemented

English | [中文](2026-08-16-temp-spill-dir-cleanup.zh.md)

## Problem

Every DSH process that spills oversized tool output or subprocess output created a private (0700) scratch directory under the OS temp dir — `dsh-spill-*` from `@deepseek-ai/dsh-spill-local`'s default root and `dsh-subprocess-*` from `@deepseek-ai/dsh-subprocess-local`'s default spill location. Both directories were created lazily (`mkdtempSync(join(tmpdir(), …))`) and nothing ever removed them. A long-lived machine accumulated hundreds of empty or stale directories — the per-process directories are pure scratch, not durable data, so each process exit leaked one more.

## Decision

Each seam now removes the temp directory it owns, on both teardown paths:

- `@deepseek-ai/dsh-spill-local` exports `removePrivateRootSync()` from `store.ts`. `LocalSpillStore` registers a `ctx.effect` (label `local spill root teardown`) only when the deployment omitted `config.root`: the disposer removes the default root (graceful context disposal), and a `prepend`ed `process` `exit` listener removes it again as the synchronous fallback for exits that skip disposal. A configured `root` is the deployment's own storage and is never removed.
- `@deepseek-ai/dsh-subprocess-local` exports `removeDefaultSpillDirSync()` from `spawn.ts`. The service's existing `exit` finalizer removes the default spill directory after force-terminating live trees, and `disposeManagedProcesses()` removes it once after every tree has settled (the quiescence point) — the graceful path, since the CLI disposes the application tree before exiting and therefore never runs the `exit` fallback.

Both removals reset the module-level default to `undefined`, so a later use in the same process (another context mount, another spawn) creates a fresh directory instead of reusing the removed path. Each removal guard refuses to descend through a link-shaped path that replaced the directory: a real directory is removed recursively, anything else is unlinked without traversal, and absence, races, and Windows locks are swallowed — temp cleanup must never fail teardown. The two guards are deliberate near-copies because each seam owns its scratch directory independently; the shared extraction would create a cross-seam dependency for a dozen lines.

The session persistence logs under `$DSH_HOME/sessions` are deliberately unchanged: they are the durable resume/query record, not scratch, and their retention stays a product decision.

## Alternatives considered

**Remove the directory only in the `exit` listener.** Rejected: the CLI's graceful shutdown disposes the application tree first, which unregisters effect-owned `exit` listeners before the event fires — the normal path would then never clean up. Both paths are required.

**Remove the directory at every context disposal but not at host exit.** Rejected: non-graceful exits (crashes, forced `process.exit`) would keep leaking.

**Reuse one shared cleanup helper across packages.** Rejected: the two seams are independent packages; extracting a shared module for one short function adds a dependency edge and a package for no ownership benefit.

**Extend the OS temp cleaner or a cron-style sweeper instead.** Rejected: directories belong to live processes until they exit; a background sweeper cannot safely tell a stale directory from an active one, while the owner knows exactly when it is done.

**Auto-prune `$DSH_HOME/sessions` in the same change.** Rejected: session logs are user data with resume and query value; retention policy belongs to the product, not to a leak fix.

## Consequences

- Normally exiting processes leave no `dsh-spill-*` or `dsh-subprocess-*` directory behind; directories from crashed or force-killed processes remain until the OS temp cleaner reclaims them, as before.
- A configured spill `root` or test-injected `spillDir` is never touched; only the internally created default directory is removed.
- Removal is best-effort: on Windows an open spill file can make the recursive removal fail, which is swallowed and leaves the directory for the OS temp cleaner.
- Tests pin both paths per seam: disposal removal, `exit`-finalizer removal, non-directory swap unlinking, and absent/default-cleared tolerance (`spill-local.spec.ts`, `local.spec.ts`).

# Agent Note: The background-job badge hides itself once the last job settles

Status: implemented

English | [中文](2026-08-15-job-badge-hides-when-idle.zh.md)

## Problem

The session header's background-job entry listed every `ctx.jobs` record the session could see, live or settled, and kept the trigger mounted for as long as any record existed. For a session whose jobs had all finished, that meant a permanent "N 个后台任务" badge — and the rows are read-only (no navigation, no detail), so a settled-only list was a history page nobody asked for, occupying header space indefinitely: the registry drops settled records only at owner disposal, which in a long-lived session means effectively never.

## Decision

`JobListAction` renders only while at least one job is live (`running` or `stopping`). The last live job settling closes the list first, then unmounts the control, trigger and popover together. The count label therefore always reports the live figure — it is non-zero by construction while the control renders — and the idle-count locale keys are gone. Settled rows still render inside the list, as the recent-outcome tail alongside the live rows, keeping their order, status words, and frozen durations unchanged.

The unmount rides the existing `jobsBySession` mirror: no new RPC and no registry change. A finished job's outcome stays legible where the work is actually visible — the conversation's own tool row.

## Alternatives considered

**Add a "clear finished" action to the list.** The explicit path: keep the badge and let the human delete settled rows. Rejected for this request because it needs a new registry API, an api-proxy route, a client remote, and a UI affordance across four layers to restore a default state the lifecycle below reaches for free — and a badge that exists only while work runs never needs clearing.

**Keep the trigger and only drop the count.** Hides the number but leaves an unlabeled, settled-only control in the header — the clutter the request is about, renamed rather than removed.

**Filter settled rows out of the list while it is open.** Would remove the outcome tail while live jobs still run, and contradicts the pinned ordering and status rendering; rejected.

## Consequences

- A session whose background work has all finished shows no job control at all; the header returns to crumbs and utilities.
- The open-list settle flip is gone: when the last live job settles, the list unmounts rather than flipping to a settled row. The settled golden pinning that flip is removed from the web e2e scenario, which now pins trigger and open list detaching together.
- The count label has no idle fallback anymore; `count.idle.*` is removed from both locale dictionaries.
- Unit and e2e coverage pins the new lifecycle: a settled-only session renders nothing, and killing the last live job removes the trigger together with the open list.

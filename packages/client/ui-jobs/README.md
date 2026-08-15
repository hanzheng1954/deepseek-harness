---
description: "Web background-job surface: the session-header action listing the jobs this session can see; for users and maintainers of the background-job experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

English | [中文](README.zh.md)

## Summary

This package renders the background-job surface of the Web GUI: a session-header action that opens a popover listing the jobs this session can see. It reads host-computed registry state through the runtime's `jobsBySession` mirror and issues no RPC of its own. The trigger appears only while the session has a running or stopping job, and its badge counts those live jobs; settled rows remain visible and de-emphasized only alongside live work. The last live job settling closes and unmounts the control, because the conversation's tool row owns the durable outcome. The model's view of the same jobs belongs to `dsh-tool-jobs`; this package is a read-only projection for the human.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside the runtime; the job action appears in the session header whenever the session has at least one live job. A click opens the popover: live rows first by start time, then settled rows by finish time, each showing the producer kind, label, status, and an elapsed duration that ticks once per second while live and freezes at completion. Settled rows disappear with the control when the last live job settles.

### Dismissal and limits

Escape closes the list and returns focus to the trigger, as does a pointer press outside it. The last live job settling closes the list before the control unmounts, so focus does not remain on a removed trigger. The list shows what one session can see through the wire view, so a job owned by another session never appears here; a process restart empties the list while the transcript keeps the `run_in_background` cards that started those jobs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package contributes one entry to `conversation.session.header.actions` (`JobListAction`), and the data arrives entirely through the `jobsBySession` list mirror that the Session Controller binding folds from `session/jobs` frames — no RPC, and no state beyond popover visibility. The badge counts `running` plus `stopping`; a zero count unmounts the whole entry. Rows are ordered with live rows first by `startedAt` ascending, then settled rows by `finishedAt` descending, with a same-millisecond tie broken on start order; a settled row missing `finishedAt` reads as zero rather than as a negative figure, and a duration past an hour stays in hours. The behavior is specified by the [Web background-job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md), with the live-only trigger lifecycle owned by the [job-badge lifecycle note](../../../.agents/notes/implemented/bug-fix/2026-08-15-job-badge-hides-when-idle.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the job surface is not enough. They move from the browser list to the registry and the model-facing tool.

- [dsh-tool-jobs](../../jobs/tool-jobs/README.md) — the model-facing jobs tool over the same registry.
- [Session Controller](../../api/session-controller/README.md) — folds the `jobsBySession` mirror this package reads.
- [ui-subagent](../ui-subagent/README.md) — the subagent catalog, where a running one-shot background subagent also appears.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders host-computed registry state for a human and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current job list. They are current package constraints, not a general job-management comparison or a task backlog.

- **Rows are read-only** — a job's streamed output and a human-initiated cancellation are separate phases. Cancellation additionally owes a model-facing decision the seam does not answer: `kill()` marks terminal delivery reported, so an interrupt written against the current contract would leave the model believing its job is still running.
- **The list is not the registry's own set** — it shows what one session can see through the wire view, so a job owned by another session never appears here, and a process restart empties the list while the transcript keeps the `run_in_background` cards that started those jobs. An unowned job (one started without a live `Agent`) reaches every session's list, matching what `list(caller)` reports to every caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package is a read-only projection of the `jobsBySession` mirror onto one header slot entry. It emits no Cordis events, owns no cross-plugin mutable state, and its single slot registration proves disposal through the HMR-safety spec.

# @deepseek-ai/dsh-client-ui-jobs

English | [中文](README.zh.md)

Web background-job feature owner: contributes one entry to `conversation.session.header.actions` listing the `ctx.jobs` records this session can see. The data arrives entirely through the `jobsBySession` list mirror that [`dsh-client-runtime`](../runtime/README.md) folds from `session/jobs` frames, so this package issues no RPC and holds no state beyond popover visibility.

The trigger renders only while the session has at least one live job, so an ordinary conversation never grows a control for a capability it is not using, and finished work never lingers as a badge: the last live job settling unmounts the control, trigger and popover together ([the job-badge lifecycle note](../../../.agents/notes/implemented/bug-fix/2026-08-15-job-badge-hides-when-idle.md)). Its badge counts `running` plus `stopping`, non-zero by construction while the control renders. The popover is a flat list: live rows first by `startedAt` ascending, then settled rows by `finishedAt` descending, with a same-millisecond tie broken on start order so the host's map iteration never decides it. A row shows the producer kind, the label, a status marker, the producer's `detail` in place of the generic status word once it has one, and an elapsed duration. That duration advances once per second while the row is live and freezes at `finishedAt`; the clock runs only while an open list holds something that moves. A settled row missing `finishedAt` reads as zero rather than as a negative figure, and a duration past an hour stays in hours rather than growing a day vocabulary no producer currently reaches.

Settled rows stay visible and de-emphasized only alongside at least one live row — the recent-outcome tail of work still running. When the last live job settles, the control unmounts and the settled history goes with it: a job's outcome is the conversation's own tool row, so a permanent history badge would be the registry's shadow rather than a capability in use. A failed job's `detail` is the only place its failure is legible while the list lasts. A running one-shot background subagent therefore appears both here and in the [subagent catalog](../ui-subagent/README.md): the catalog navigates into the child's transcript, while this list is the only handle a future cancellation can attach to.

Escape closes the list and returns focus to the trigger, as does a pointer press outside it. The last live job settling — like the job array emptying — closes the list before the control unmounts, so focus never vanishes from a removed node. Styling uses tokens only; copy goes through the package's own `job` locale namespace. The behavior is specified by the [Web background-job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md) and its hide-when-idle lifecycle by the [job-badge lifecycle note](../../../.agents/notes/implemented/bug-fix/2026-08-15-job-badge-hides-when-idle.md).

## Model Experience

None, as this package renders host-computed registry state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same jobs stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Rows are read-only** — a job's streamed output and a human-initiated cancellation are separate phases. Cancellation additionally owes a model-facing decision the seam does not answer today: `kill()` marks terminal delivery reported, so an interrupt written against the current contract would leave the model believing its job is still running.
- **The list is not the registry's own set** — it shows what one session can see through the wire view, so a job owned by another session never appears here, and a process restart empties the list while the transcript keeps the `run_in_background` cards that started those jobs. An unowned job (one started without a live `Agent`) is the opposite case: it reaches every session's list, matching what `list(caller)` reports to every caller.

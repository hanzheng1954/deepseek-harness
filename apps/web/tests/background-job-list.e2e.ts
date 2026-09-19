// Session-header background jobs driven by a real `ctx.jobs` entry. No model
// call is involved.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/background-job-list', import.meta.url))
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'background-job-list-web-e2e'
// Long enough that the running assertions never race the process exiting on
// their own; the test kills it explicitly to reach the settled state.
const COMMAND = 'sleep 45'

/**
 * Wait for opening a session to publish its live Agent.
 * @param scaffold - the booted web scaffold.
 * @param sessionId - the opened session's identity.
 * @returns the registered Agent instance.
 */
async function liveAgent(scaffold: WebScaffold, sessionId: SessionId): Promise<Agent> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const found = scaffold.ctx.agents.get(sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`opening session "${sessionId}" published no live Agent`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe.skipIf(MODE === 'record')('web e2e: background job list', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let jobId: JobId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // Opening the session drives the Host's ordinary Agent resolution; the
    // job owner must be that exact live instance, never a second one.
    // `expect.poll` is test-scoped, so this hook polls by hand.
    agent = await liveAgent(scaffold, SessionId(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a running background job in the session header without a refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-running'))
    // Polling for zero would pass at t=0 before delivery and prove nothing.
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(0)

    let settle!: (outcome: { status: 'killed'; detail: string }) => void
    jobId = scaffold.ctx.jobs.start({
      kind: 'bash',
      label: COMMAND,
      owner: agent,
      run: () => ({
        cancel: (reason) => { settle({ status: 'killed', detail: reason ?? 'cancelled' }) },
        done: new Promise((resolve) => { settle = resolve }),
      }),
    })

    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const row = page.getByRole('list', { name: 'Background jobs' }).getByRole('listitem').first()
    await row.waitFor({ timeout: 10_000 })
    await expect.poll(() => row.textContent()).toContain(COMMAND)

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the job list inside a phone viewport', async () => {
    // The trigger sits at the header's right end; the 336px list anchored at
    // its left edge runs past a phone's right viewport edge (only the first
    // ~90px stay visible). On narrow columns the list re-anchors to the
    // session header (JobListAction.module.css, <=600px) and takes a
    // column-relative width, so every row stays reachable. Runs while the
    // previous scenario's job is still live — the control exists only for
    // work in flight.
    const mobilePage = await newEnglishPage(browser, 844)
    onTestFailed(() => saveFailureShot(mobilePage, 'web-e2e-background-job-mobile'))
    const mobileTripwire = watchConsole(mobilePage)
    try {
      await mobilePage.setViewportSize({ width: 360, height: 844 })
      await mobilePage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await mobilePage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      // Open the seeded session through the expanded sidebar.
      await mobilePage.getByRole('button', { name: 'Open sidebar' }).click()
      const groupRow = mobilePage.locator('[role="treeitem"]').first()
      await groupRow.waitFor({ timeout: 15_000 })
      await groupRow.click()
      const sessionRow = mobilePage.locator('[role="treeitem"]').nth(1)
      await sessionRow.waitFor({ timeout: 10_000 })
      await sessionRow.click()
      // Picking the session dismisses the narrow drawer; wait for the rail
      // to return before driving the header trigger.
      await mobilePage.getByRole('button', { name: 'Open sidebar' }).waitFor({ timeout: 10_000 })
      const trigger = mobilePage.getByRole('button', { name: '1 background job running' })
      await trigger.waitFor({ timeout: 20_000 })
      await trigger.click()
      const menu = mobilePage.getByRole('list', { name: 'Background jobs' })
      await menu.waitFor({ timeout: 10_000 })
      const box = await menu.boundingBox()
      expect(box).not.toBeNull()
      // Fully inside the viewport, clear of the rail.
      expect(box!.x + box!.width).toBeLessThanOrEqual(360)
      expect(box!.x).toBeGreaterThanOrEqual(64)
      // The rendered row itself remains inside the viewport; menu padding or
      // rounded corners need not be row hit targets.
      const rowBox = await menu.getByRole('listitem').first().boundingBox()
      expect(rowBox).not.toBeNull()
      expect(rowBox!.x).toBeGreaterThanOrEqual(box!.x)
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(360)
      expect(mobileTripwire.pageErrors).toEqual([])
    } finally {
      await mobilePage.close()
    }
  }, 60_000)

  it('unmounts the header control once the last live job settles', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-settled'))
    // The running scenario left the job live and the list open; pin both
    // before the kill so the polls below cannot pass vacuously.
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(1)
    expect(await page.getByRole('list', { name: 'Background jobs' }).count()).toBe(1)
    expect(scaffold.ctx.jobs.kill(jobId, agent, 'web e2e cancellation')).toBe('requested')

    // The control exists for work in flight: the settle removes trigger and
    // list together — the trigger never lingers as a settled-history badge.
    await expect.poll(() => trigger.count(), { timeout: 20_000 }).toBe(0)
    await expect.poll(() => page.getByRole('list', { name: 'Background jobs' }).count(), { timeout: 10_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md'])
  })
})

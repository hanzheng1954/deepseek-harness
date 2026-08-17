// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { BalanceChip } from '../src/client/BalanceChip.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Same lookup-chain stub as the model-select spec: package dictionary, then
// common vocabulary, then the bare key.
const t: ComponentProps<typeof BalanceChip>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BalanceChip', () => {
  it('renders the resolved balance and repolls once a minute', async () => {
    vi.useFakeTimers()
    const loadBalance = vi.fn(async () => ({
      currency: 'CNY', total: 905.48, toppedUp: 905.48, granted: 0,
    }))
    render(<BalanceChip loadBalance={loadBalance} t={t} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('DeepSeek 余额 ¥905.48')).toBeTruthy()
    expect(loadBalance).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(loadBalance).toHaveBeenCalledTimes(2)
  })

  it('degrades to an error label carrying the diagnosis on hover', async () => {
    vi.useFakeTimers()
    const loadBalance = vi.fn(async () => { throw new Error('401 bad key') })
    render(<BalanceChip loadBalance={loadBalance} t={t} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const chip = screen.getByText('余额不可用')
    expect(chip.getAttribute('data-state')).toBe('error')
    expect(chip.getAttribute('title')).toContain('401 bad key')
  })
})

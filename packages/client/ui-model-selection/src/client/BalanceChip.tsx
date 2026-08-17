/**
 * DeepSeek account-balance chip: an ambient readout in the composer dock
 * (`conversation.composer.dock`) showing the deepseek-official balance. The
 * host query runs on mount, once a minute, and on window focus — the dock
 * contract keeps interactive controls in the tool row, so this chip is
 * purely informational (hover for the topped-up/granted breakdown) and a
 * failed query degrades to a tooltip-carrying error label instead of a
 * click target. Framework-free: the `loadBalance` query is injected by the
 * registration, so the component imports no cordis faces.
 */

import { useEffect, useRef, useState } from 'react'
import type { ProviderBalanceView } from '@deepseek-ai/dsh-client-connection/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BalanceChip.module.css'

/** Refresh cadence: one minute — an account balance is a slow fact. */
const REFRESH_MS = 60_000

/** Currency display symbols; unknown codes render as the code itself. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  JPY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
}

/** Two-decimal amount with the provider's currency symbol (or bare code). */
function formatAmount(balance: ProviderBalanceView): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `
  return `${symbol}${balance.total.toFixed(2)}`
}

/** Hour:minute:second refresh timestamp for the hover detail. */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

export interface BalanceChipProps {
  /** Host query resolving the current deepseek-official balance, or undefined when unavailable. */
  loadBalance: (signal: AbortSignal) => Promise<ProviderBalanceView | undefined>
  /** The dock entry's locale seat. */
  t: TranslateNS<'model'>
}

/** The composer-dock balance readout (see module doc). */
export function BalanceChip({ loadBalance, t }: BalanceChipProps) {
  const [balance, setBalance] = useState<ProviderBalanceView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [refreshedAt, setRefreshedAt] = useState<number | undefined>()

  // Latest-query ref: the polling effect runs once, so the query it calls must
  // follow the prop (injected per registration, stable in practice).
  const loadRef = useRef(loadBalance)
  loadRef.current = loadBalance

  useEffect(() => {
    let disposed = false
    let controller: AbortController | null = null
    const refresh = (): void => {
      controller?.abort()
      controller = new AbortController()
      const signal = controller.signal
      void loadRef.current(signal).then(
        (value) => {
          if (disposed || signal.aborted) return
          setBalance(value)
          setError(undefined)
          setRefreshedAt(Date.now())
        },
        (reason: unknown) => {
          if (disposed || signal.aborted) return
          setError(reason instanceof Error ? reason.message : String(reason))
        },
      )
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    // A focus refresh keeps the readout honest after the tab sat in the
    // background past several timer throttlings.
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      controller?.abort()
    }
  }, [])

  // Nothing renders until the first query settles — an empty first frame
  // beats a placeholder that would reflow the stats line.
  if (balance === undefined && error === undefined) return null

  const text = balance !== undefined
    ? `${t('balance.label')} ${formatAmount(balance)}`
    : t('balance.error')

  const title = balance !== undefined
    ? t('balance.detail', {
      toppedUp: `${CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `}${balance.toppedUp.toFixed(2)}`,
      granted: `${CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `}${balance.granted.toFixed(2)}`,
      refreshedAt: refreshedAt === undefined ? '—' : formatTime(refreshedAt),
    })
    : error

  return (
    <span
      className={css.chip}
      data-state={balance !== undefined ? 'ok' : 'error'}
      title={title}
      aria-label={text}
    >
      {text}
    </span>
  )
}

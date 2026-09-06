/**
 * Provider-routed model-request retry policy on the agent loop's request
 * recovery extension point. Each scheduled retry is durable before its cancellable wait.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RetryId } from './brand.ts'
import type { LlmRetryEventData } from './types.ts'

/**
 * Optional global retry-count override, written by the dsh-retry settings row to
 * `<DSH_HOME>/dsh-retry.json` ({ maxRetries }). When present it replaces a
 * *normal* policy's maxRetries for every provider (an always policy is already
 * unbounded); when ABSENT it returns undefined and each policy keeps its own
 * value — so the app-wide default lives in resolveRetryPolicy, not here, and
 * tests that set an explicit maxRetries are untouched. Cached briefly to stay
 * off the hot recovery path.
 */
const OVERRIDE_TTL_MS = 1_000
let overrideCache: { at: number; value: number | undefined } | undefined

function globalMaxRetries(): number | undefined {
  const now = Date.now()
  if (overrideCache !== undefined && now - overrideCache.at < OVERRIDE_TTL_MS) return overrideCache.value
  let value: number | undefined
  try {
    const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'dsh-retry.json'), 'utf8'))
    const candidate = (parsed as { maxRetries?: unknown })?.maxRetries
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) value = candidate
  } catch { /* absent / unreadable → no override */ }
  overrideCache = { at: now, value }
  return value
}

export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'
export { RetryId } from './brand.ts'

export const name = 'llm-retry'
export const inject = ['agents']

/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`llm-retry: unknown key "${key}"`)
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ])
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install provider-routed normal or unbounded request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedRetryPolicy,
    policyKey: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    const eventData: LlmRetryEventData = policy.mode === 'normal'
      ? {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        failure,
      }
      : {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        delayMs,
        failure,
      }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover(
    { agent, turn, step, provider, failure, retryPolicy, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (retryPolicy === undefined) return next()
    // One retry count for every provider (dsh-retry settings row) replaces a
    // normal policy's maxRetries; an always policy is already unbounded.
    let policy: ResolvedRetryPolicy = retryPolicy
    if (policy.mode === 'normal') {
      const override = globalMaxRetries()
      if (override !== undefined && override !== policy.maxRetries) {
        policy = Object.freeze({ ...policy, maxRetries: override }) as ResolvedRetryPolicy
      }
    }
    if (policy.mode === 'always') {
      if (signal.aborted || lifetime.signal.aborted) return
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      // The loop and plugin lifetime stay open until delegated recovery settles.
      // An abort then wins before the decision or fallback can mutate later state.
      const downstream = await settleDownstream(next)
      if (fusedSignal.aborted) return
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry: provider "${provider}" always policy ignored a downstream recovery failure: %o`,
          downstream.error,
        )
      }
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
        return downstream.decision
      }
    } else if (!policy.retryableCodes.includes(failure.code)) {
      return next()
    }

    const policyKey = retryPolicyKey(policy)
    const priorPolicyRetry = agent.session.events.findLast((event): event is SessionEvent<'llm/retry'> =>
      event.type === 'llm/retry'
      && event.data.turn === turn
      && event.data.step === step
      && event.data.provider === provider
      && event.data.policyKey === policyKey,
    )
    const previousRetry = priorPolicyRetry?.data.retry ?? 0
    if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next()
    const retry = previousRetry + 1
    const retryId = priorPolicyRetry?.data.retryId ?? RetryId(randomUUID())
    let delayMs: number
    if (failure.providerRetryAfterMs !== undefined
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      if (failure.providerRetryAfterMs > policy.maxDelayMs) {
        if (policy.mode === 'normal') return next()
        delayMs = localDelay(policy, retry, random)
      } else {
        delayMs = failure.providerRetryAfterMs
      }
    } else {
      delayMs = localDelay(policy, retry, random)
    }

    return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('llm-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry: abort and drain active recovery')
}

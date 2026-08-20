/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-image-ocr`.
 * @module @deepseek-ai/dsh-image-ocr/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-image-ocr'

/** Cordis companion plugin name. */
export const name = 'image-ocr-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a recogniser owns nothing but a bounded digest cache
 * private to its own instance, and each run is one stateless child-process
 * round trip; behavior is enforced by unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

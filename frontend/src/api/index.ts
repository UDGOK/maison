import { frappeApi } from './frappe'
import { mockApi } from './mock'
import type { AwanzApi } from './types'

export const IS_MOCK = import.meta.env.VITE_MOCK === '1'

/** The active API implementation — mock when VITE_MOCK=1, Frappe otherwise. */
export const api: AwanzApi = IS_MOCK ? mockApi : frappeApi

export * from './types'

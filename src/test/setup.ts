import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, beforeEach } from 'vitest'

const store = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size
  },
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => store.clear())

const originalFetch = globalThis.fetch
beforeAll(() => {
  if (!originalFetch) return
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    if (url.includes('/__api/')) {
      return new Response(JSON.stringify({ ok: true, value: {}, server_now: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return originalFetch(input as RequestInfo, init)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

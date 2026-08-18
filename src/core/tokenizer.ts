// Token counting in a Web Worker (gpt-tokenizer), with a naive fallback.
// The worker keeps the grid's streaming updates off the main thread; any
// worker failure (unsupported environment, load error, timeout) degrades to
// the naive chars/4 estimate rather than blocking or crashing.

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (count: number) => void; timer: ReturnType<typeof setTimeout>; text: string }>()

export function naiveTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

function settle(id: number, count: number): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(count)
}

function failAll(): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(naiveTokenCount(entry.text))
  }
}

export function countTokens(text: string): Promise<number> {
  if (!text) return Promise.resolve(0)
  if (typeof Worker === 'undefined') return Promise.resolve(naiveTokenCount(text))

  return new Promise(resolve => {
    try {
      if (!worker) {
        worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), { type: 'module' })
        worker.addEventListener('message', (event: MessageEvent<{ id: number; count: number }>) => {
          if (event.data && typeof event.data.id === 'number') settle(event.data.id, event.data.count)
        })
        worker.addEventListener('error', () => {
          // Worker died: fail everything in flight and never touch it again.
          worker?.terminate()
          worker = null
          failAll()
        })
      }

      const id = seq++
      const timer = setTimeout(() => settle(id, naiveTokenCount(text)), 3000)
      pending.set(id, { resolve, timer, text })
      worker.postMessage({ id, text })
    } catch {
      resolve(naiveTokenCount(text))
    }
  })
}
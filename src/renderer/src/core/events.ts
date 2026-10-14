type Handler<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>()

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`handler for ${String(event)} failed`, err)
      }
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: A) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn(...args)
    }, ms)
  }
  wrapped.cancel = () => t && clearTimeout(t)
  return wrapped
}

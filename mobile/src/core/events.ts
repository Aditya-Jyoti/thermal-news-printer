/** Tiny pipeline event bus: the UI subscribes and invalidates queries instead of polling. */
export type CoreEvent = 'edition' | 'prints' | 'feeds';
type Listener = (e: CoreEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emit(e: CoreEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(e);
    } catch {
      // a broken listener must never break the pipeline
    }
  }
}

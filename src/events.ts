import type { ChatEventMap, ChatEventName } from "./types"

type AnyFn = (...args: unknown[]) => void

export class TypedEventEmitter {
  private listeners = new Map<string, Set<AnyFn>>()

  on<E extends ChatEventName>(
    event: E,
    listener: ChatEventMap[E],
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener as AnyFn)
    return () => this.off(event, listener)
  }

  off<E extends ChatEventName>(
    event: E,
    listener: ChatEventMap[E],
  ): void {
    this.listeners.get(event)?.delete(listener as AnyFn)
  }

  emit<E extends ChatEventName>(
    event: E,
    ...args: Parameters<ChatEventMap[E]>
  ): void {
    this.listeners
      .get(event)
      ?.forEach((fn) => fn(...(args as unknown[])))
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}

import type { PhoenixV2Frame, EventsChannelEvent, EventHandler } from '../types.js';
import { PhoenixSocket } from '../phoenix-socket.js';
import { ChatStore } from '../store/store.js';
import { getEventsTopic } from '../topics.js';

export class EventsChannel {
  private socket: PhoenixSocket;
  private store: ChatStore;
  private userId: string;
  private topic: string;
  private listeners: Map<string, Set<EventHandler<EventsChannelEvent>>> = new Map();
  private wildcardListeners: Set<EventHandler<EventsChannelEvent>> = new Set();
  private frameUnsub: (() => void) | null = null;
  private _joined = false;

  constructor(socket: PhoenixSocket, store: ChatStore, userId: string) {
    this.socket = socket;
    this.store = store;
    this.userId = userId;
    this.topic = getEventsTopic(userId);
  }

  get joined(): boolean {
    return this._joined;
  }

  async connect(): Promise<void> {
    if (this._joined) return;

    const lastSeq = await this.store.getLastEventSequence(this.userId);
    const joinPayload: Record<string, unknown> = {};
    if (lastSeq > 0) {
      joinPayload.last_sequence = lastSeq;
    }

    try {
      await this.socket.joinChannel(this.topic, joinPayload);
      this._joined = true;
      this.startListening();
    } catch {
      throw new Error(`Failed to join events channel: ${this.topic}`);
    }
  }

  disconnect(): void {
    this.stopListening();
    this._joined = false;
    this.listeners.clear();
    this.wildcardListeners.clear();
  }

  private startListening(): void {
    if (this.frameUnsub) return;
    this.frameUnsub = this.socket.onFrame(this.topic, (frame) => {
      this.handleFrame(frame);
    });
  }

  private stopListening(): void {
    if (this.frameUnsub) {
      this.frameUnsub();
      this.frameUnsub = null;
    }
  }

  private handleFrame([_joinRef, _ref, _topic, event, payload]: PhoenixV2Frame): void {
    if (event !== 'event' && event !== 'new_notification') return;

    if (event === 'new_notification') {
      const ev: EventsChannelEvent = {
        type: 'notification_created',
        payload: payload as Record<string, unknown>,
        sequence: 0,
        occurredAt: new Date().toISOString(),
      };
      this.dispatch(ev);
      return;
    }

    const ev: EventsChannelEvent = {
      type: (payload.type as string) ?? 'unknown',
      payload: (payload.payload as Record<string, unknown>) ?? payload,
      sequence: (payload._sequence as number) ?? 0,
      occurredAt: (payload.occurred_at as string) ?? new Date().toISOString(),
    };

    if (ev.sequence > 0) {
      this.store.saveLastEventSequence(this.userId, ev.sequence);
    }

    this.dispatch(ev);
  }

  private dispatch(event: EventsChannelEvent): void {
    this.wildcardListeners.forEach((cb) => cb(event));
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach((cb) => cb(event));
    }
  }

  on(eventType: string, callback: EventHandler<EventsChannelEvent>): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);
    return () => {
      this.listeners.get(eventType)?.delete(callback);
    };
  }

  onAny(callback: EventHandler<EventsChannelEvent>): () => void {
    this.wildcardListeners.add(callback);
    return () => {
      this.wildcardListeners.delete(callback);
    };
  }
}

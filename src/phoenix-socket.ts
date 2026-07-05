import type { ConnectionState, ChatClientConfig } from './types.js';
import { Socket, Channel } from 'phoenix';

type ConnectionListener = (state: ConnectionState, previous: ConnectionState) => void;
type FrameHandler = (frame: [string | null, string | null, string, string, Record<string, unknown>]) => void;

export class PhoenixSocket {
  private socket: Socket | null = null;
  private channels: Map<string, Channel> = new Map();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private frameHandlers: Map<string, Set<FrameHandler>> = new Map();
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private connectResolve: (() => void) | null = null;
  private connectPromise: Promise<void> | null = null;

  private getAccessToken: () => Promise<string>;
  private wsBaseUrl: string;
  private reconnectBaseDelayMs: number;
  private reconnectMaxDelayMs: number;
  private reconnectMaxAttempts: number;
  private joinTimeoutMs: number;
  private pushTimeoutMs: number;

  joinedChannels: Set<string> = new Set();

  constructor(config: ChatClientConfig) {
    this.getAccessToken = config.getAccessToken;
    const base = config.wsBaseUrl.replace(/\/+$/, '');
    this.wsBaseUrl = base.endsWith('/ws') ? base : `${base}/ws`;
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = config.reconnectMaxDelayMs ?? 30_000;
    this.reconnectMaxAttempts = config.reconnectMaxAttempts ?? 10;
    this.joinTimeoutMs = config.joinTimeoutMs ?? 10_000;
    this.pushTimeoutMs = config.pushTimeoutMs ?? 5_000;
  }

  private setState(state: ConnectionState): void {
    const prev = this.connectionState;
    if (prev === state) return;
    this.connectionState = state;
    this.connectionListeners.forEach((fn) => fn(state, prev));
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(fn: ConnectionListener): () => void {
    this.connectionListeners.add(fn);
    return () => { this.connectionListeners.delete(fn); };
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>(async (resolve, reject) => {
      try {
        const token = await this.getAccessToken();
        this.intentionalClose = false;
        this.setState('connecting');

        this.socket = new Socket(this.wsBaseUrl, {
          params: { token },
          heartbeatIntervalMs: 15_000,
          reconnectAfterMs: () => {
            if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
              this.setState('failed');
              return Infinity;
            }
            const delay = Math.min(
              this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempt),
              this.reconnectMaxDelayMs,
            );
            this.reconnectAttempt++;
            return delay;
          },
        });

        this.socket.onOpen(() => {
          this.setState('connected');
          this.reconnectAttempt = 0;
          this.connectResolve?.();
          resolve();
        });

        this.socket.onClose(() => {
          this.connectPromise = null;
          this.connectResolve = null;
          if (!this.intentionalClose) {
            this.setState('reconnecting');
          } else {
            this.setState('disconnected');
          }
        });

        this.socket.onError(() => {
          if (this.connectionState === 'connecting') {
            reject(new Error('Connection failed'));
            this.connectPromise = null;
          }
        });

        this.socket.connect();
      } catch (err) {
        this.connectPromise = null;
        this.setState('disconnected');
        reject(err);
      }
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channels.forEach((ch) => ch.leave());
    this.channels.clear();
    this.joinedChannels.clear();
    this.frameHandlers.clear();
    this.socket?.disconnect();
    this.socket = null;
    this.connectPromise = null;
    this.setState('disconnected');
  }

  retryConnection(): void {
    this.reconnectAttempt = 0;
    this.connect().catch(() => {});
  }

  private ensureConnected(): void {
    if (!this.socket || !this.isConnected()) {
      throw new Error('Socket not connected');
    }
  }

  private getOrCreateChannel(topic: string): Channel {
    let ch = this.channels.get(topic);
    if (!ch) {
      this.ensureConnected();
      ch = this.socket!.channel(topic);
      this.channels.set(topic, ch);
    }
    return ch;
  }

  push(topic: string, event: string, payload: Record<string, unknown>): void {
    const ch = this.getOrCreateChannel(topic);
    ch.push(event, payload);
  }

  pushWithReply(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ch = this.getOrCreateChannel(topic);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Push timeout: ${event} on ${topic}`));
      }, this.pushTimeoutMs);

      ch.push(event, payload)
        .receive('ok', (resp: unknown) => {
          clearTimeout(timer);
          resolve(resp as Record<string, unknown>);
        })
        .receive('error', (resp: unknown) => {
          clearTimeout(timer);
          reject(new Error(typeof resp === 'string' ? resp : JSON.stringify(resp)));
        });
    });
  }

  joinChannel(
    topic: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Not connected'));
    }

    const ch = this.socket!.channel(topic, payload);
    this.channels.set(topic, ch);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Join timeout: ${topic}`));
      }, this.joinTimeoutMs);

      ch.join()
        .receive('ok', (resp: unknown) => {
          clearTimeout(timer);
          this.joinedChannels.add(topic);
          this.setupChannelHandlers(ch, topic);
          resolve(resp as Record<string, unknown>);
        })
        .receive('error', (resp: unknown) => {
          clearTimeout(timer);
          reject(new Error(typeof resp === 'string' ? resp : JSON.stringify(resp)));
        });
    });
  }

  private setupChannelHandlers(ch: Channel, topic: string): void {
    const forwardEvent = (event: string) => {
      ch.on(event, (payload: Record<string, unknown>) => {
        const handlers = this.frameHandlers.get(topic);
        if (handlers) {
          const frame: [string | null, string | null, string, string, Record<string, unknown>] = [
            null, null, topic, event, payload,
          ];
          handlers.forEach((fn) => fn(frame));
        }
      });
    };

    forwardEvent('new_message');
    forwardEvent('typing');
    forwardEvent('messages_read');
    forwardEvent('messages_delivered');
    forwardEvent('presence_state');
    forwardEvent('presence_diff');
  }

  leaveChannel(topic: string): void {
    const ch = this.channels.get(topic);
    if (ch) {
      ch.leave();
      this.channels.delete(topic);
    }
    this.joinedChannels.delete(topic);
    this.frameHandlers.delete(topic);
  }

  onFrame(topic: string, handler: FrameHandler): () => void {
    if (!this.frameHandlers.has(topic)) {
      this.frameHandlers.set(topic, new Set());
    }
    this.frameHandlers.get(topic)!.add(handler);
    return () => {
      this.frameHandlers.get(topic)?.delete(handler);
    };
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.isConnected();
  }

  hasJoined(topic: string): boolean {
    return this.joinedChannels.has(topic);
  }
}

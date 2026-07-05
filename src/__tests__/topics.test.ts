import { describe, it, expect } from 'vitest';
import {
  getChatTopic,
  getEventsTopic,
  buildSupportChannelUrl,
} from '../topics.js';

describe('topics', () => {
  describe('getChatTopic', () => {
    it('returns correct topic for conversation id', () => {
      const convId = '550e8400-e29b-41d4-a716-446655440000';
      expect(getChatTopic(convId)).toBe(`chat:${convId}`);
    });
  });

  describe('getEventsTopic', () => {
    it('returns correct topic', () => {
      expect(getEventsTopic('user-1')).toBe('events:user-1');
    });
  });

  describe('buildSupportChannelUrl', () => {
    it('builds URL with token and VSN', () => {
      const url = buildSupportChannelUrl('ws://localhost:4000', 'abc123', 'user-1');
      expect(url).toContain('ws://localhost:4000/websocket');
      expect(url).toContain('token=abc123');
      expect(url).toContain('vsn=2.0.0');
    });

    it('strips trailing slashes from base URL', () => {
      const url = buildSupportChannelUrl('ws://localhost:4000///', 't', 'u');
      expect(url).toContain('ws://localhost:4000/websocket');
    });

    it('does not add duplicate /websocket path', () => {
      const url = buildSupportChannelUrl('ws://localhost:4000/websocket', 't', 'u');
      expect(url).toMatch(/^ws:\/\/localhost:4000\/websocket\?/);
      expect(url).not.toContain('/websocket/websocket');
    });
  });
});

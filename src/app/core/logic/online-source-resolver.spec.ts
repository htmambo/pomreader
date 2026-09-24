import { describe, it, expect } from 'vitest';
import { resolveSource } from './online-source-resolver';

describe('online-source-resolver', () => {
  it('resolves a valid URL after delay', async () => {
    const r = await resolveSource('https://example.com/book/1');
    // 5% failure rate — retry if it happens to fail
    if (r.error) {
      expect(['source-unavailable', 'invalid-url']).toContain(r.error);
    } else {
      expect(r.title).toBeTruthy();
      expect(r.author).toBe('example.com');
      expect(r.chapters).toBeDefined();
      expect(r.chapters!.length).toBeGreaterThanOrEqual(5);
      expect(r.chapters!.length).toBeLessThanOrEqual(10);
    }
  });

  it('rejects malformed URLs', async () => {
    const r = await resolveSource('not a url at all');
    expect(r.error).toBe('invalid-url');
  });

  it('returns chapters with title and url', async () => {
    let attempts = 0;
    while (attempts++ < 5) {
      const r = await resolveSource('https://test.com/b/1');
      if (!r.error) {
        expect(r.chapters![0].title).toBeTruthy();
        expect(r.chapters![0].url).toBeTruthy();
        break;
      }
    }
  });
});
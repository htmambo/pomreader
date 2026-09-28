import { describe, it, expect } from 'vitest';
import { isCfChallenge } from './cf-guard';

/**
 * isCfChallenge spec — Cloudflare 挑战页判定
 *
 * 三分支逻辑：
 * 1. cf-mitigated: challenge 头 → 强制判定
 * 2. status 非 403/503 → 非挑战
 * 3. server 不含 cloudflare → 非挑战
 * 4. body snippet 含 cf 标记 → 挑战
 */

describe('isCfChallenge', () => {
  describe('cf-mitigated 头触发', () => {
    it('cf-mitigated=challenge 应无视 status 直接判定挑战', () => {
      expect(
        isCfChallenge(200, { 'cf-mitigated': 'challenge', server: 'nginx' }, '<html>ok</html>'),
      ).toBe(true);
    });

    it('cf-mitigated 大小写不敏感', () => {
      expect(isCfChallenge(200, { 'cf-mitigated': 'CHALLENGE' }, '<html></html>')).toBe(true);
    });
  });

  describe('status 判定', () => {
    it('403 + cloudflare + 挑战标记 → 挑战', () => {
      expect(isCfChallenge(403, { server: 'cloudflare' }, 'cf-chl-bypass check')).toBe(true);
    });

    it('503 + cloudflare + 挑战标记 → 挑战', () => {
      expect(isCfChallenge(503, { server: 'cloudflare' }, 'challenge-platform')).toBe(true);
    });

    it('非 403/503 status 应直接返回 false（即使有 cloudflare）', () => {
      expect(isCfChallenge(404, { server: 'cloudflare' }, 'cf-chl')).toBe(false);
      expect(isCfChallenge(500, { server: 'cloudflare' }, 'cf-chl')).toBe(false);
    });
  });

  describe('server 头判定', () => {
    it('非 cloudflare server 应返回 false（即使 403）', () => {
      expect(isCfChallenge(403, { server: 'nginx' }, 'cf-chl')).toBe(false);
      expect(isCfChallenge(403, { server: 'apache' }, 'challenge-platform')).toBe(false);
    });

    it('server 缺省应返回 false', () => {
      expect(isCfChallenge(403, {}, 'cf-chl')).toBe(false);
    });

    it('cloudflare 大小写不敏感', () => {
      expect(isCfChallenge(403, { server: 'CloudFlare' }, 'cf-chl')).toBe(true);
    });
  });

  describe('body snippet 标记', () => {
    const challengeHeaders = { server: 'cloudflare' };

    it('cf-chl 标记 → 挑战', () => {
      expect(isCfChallenge(403, challengeHeaders, '<div class="cf-chl"></div>')).toBe(true);
    });

    it('challenge-platform 标记 → 挑战', () => {
      expect(isCfChallenge(403, challengeHeaders, 'challenge-platform script')).toBe(true);
    });

    it('"Just a moment"（Cloudflare 默认文案）→ 挑战', () => {
      expect(isCfChallenge(403, challengeHeaders, '<h1>Just a moment...</h1>')).toBe(true);
    });

    it('"请稍候"（中文版 Cloudflare）→ 挑战', () => {
      expect(isCfChallenge(403, challengeHeaders, '<h1>请稍候…</h1>')).toBe(true);
    });

    it('"Attention Required" → 挑战', () => {
      expect(isCfChallenge(403, challengeHeaders, 'Attention Required! | Cloudflare')).toBe(true);
    });

    it('无任何 cf 标记 → 非挑战（即使 403）', () => {
      expect(isCfChallenge(403, challengeHeaders, '<h1>Forbidden</h1>')).toBe(false);
    });

    it('snippet 仅取前 4096 字符（长 body）', () => {
      const longBody = 'x'.repeat(5000) + 'cf-chl';
      expect(isCfChallenge(403, challengeHeaders, longBody)).toBe(false);
    });

    it('snippet 边界内 cf 标记 → 挑战', () => {
      const body = 'x'.repeat(4000) + 'cf-chl';
      expect(isCfChallenge(403, challengeHeaders, body)).toBe(true);
    });
  });
});

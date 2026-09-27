import { describe, it, expect } from 'vitest';
import { isPrivateHost } from './net-guard';

/**
 * isPrivateHost spec — SSRF 防护（electron 主进程共用）
 *
 * 覆盖 RFC 1918 + localhost + IPv6 loopback + IPv4-mapped IPv6
 */

describe('isPrivateHost', () => {
  describe('内网地址应拒绝', () => {
    it('localhost', () => {
      expect(isPrivateHost('localhost')).toBe(true);
    });

    it('IPv6 loopback ::1', () => {
      expect(isPrivateHost('::1')).toBe(true);
    });

    it('IPv4 loopback 127.x.x.x', () => {
      expect(isPrivateHost('127.0.0.1')).toBe(true);
      expect(isPrivateHost('127.255.255.255')).toBe(true);
    });

    it('RFC 1918 10.x.x.x', () => {
      expect(isPrivateHost('10.0.0.1')).toBe(true);
      expect(isPrivateHost('10.255.255.255')).toBe(true);
    });

    it('RFC 1918 192.168.x.x', () => {
      expect(isPrivateHost('192.168.0.1')).toBe(true);
      expect(isPrivateHost('192.168.255.255')).toBe(true);
    });

    it('RFC 1918 172.16-31.x.x', () => {
      expect(isPrivateHost('172.16.0.1')).toBe(true);
      expect(isPrivateHost('172.20.5.10')).toBe(true);
      expect(isPrivateHost('172.31.255.255')).toBe(true);
    });

    it('link-local 169.254.x.x', () => {
      expect(isPrivateHost('169.254.0.1')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:127.0.0.1', () => {
      // 应自动剥离 ::ffff: 前缀并递归检测 IPv4 部分
      expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:10.0.0.1', () => {
      expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:192.168.1.1', () => {
      expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true);
    });
  });

  describe('公网地址应通过', () => {
    it('公网域名', () => {
      expect(isPrivateHost('example.com')).toBe(false);
      expect(isPrivateHost('google.com')).toBe(false);
    });

    it('公网 IPv4', () => {
      expect(isPrivateHost('8.8.8.8')).toBe(false);
      expect(isPrivateHost('1.1.1.1')).toBe(false);
    });

    it('172.15 / 172.32 边界值应通过（不在 16-31 范围）', () => {
      expect(isPrivateHost('172.15.255.255')).toBe(false);
      expect(isPrivateHost('172.32.0.0')).toBe(false);
    });

    it('公网 IPv6', () => {
      expect(isPrivateHost('2001:db8::1')).toBe(false);
    });
  });
});

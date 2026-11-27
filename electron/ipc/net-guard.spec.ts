import { describe, it, expect } from 'vitest';
import { isPrivateHost } from './net-guard';

/**
 * isPrivateHost spec — SSRF 防护（electron 主进程共用）
 *
 * 覆盖 RFC 1918 + localhost + IPv6 loopback + IPv4-mapped IPv6 +
 * Node URL 对 IPv6 的方括号 / 十六进制规范化形式（回归：旧实现只比较 '::1'）
 */

describe('isPrivateHost', () => {
  describe('内网地址应拒绝', () => {
    it('localhost / 空值', () => {
      expect(isPrivateHost('localhost')).toBe(true);
      expect(isPrivateHost('localhost.')).toBe(true);
      expect(isPrivateHost('')).toBe(true);
    });

    it('IPv6 loopback ::1（含方括号形式）', () => {
      expect(isPrivateHost('::1')).toBe(true);
      // Node URL.hostname 对 http://[::1]/ 返回 '[::1]'
      expect(isPrivateHost('[::1]')).toBe(true);
      expect(isPrivateHost('::')).toBe(true);
    });

    it('IPv4 loopback 127.x.x.x', () => {
      expect(isPrivateHost('127.0.0.1')).toBe(true);
      expect(isPrivateHost('127.255.255.255')).toBe(true);
    });

    it('0.0.0.0 与 0/8', () => {
      expect(isPrivateHost('0.0.0.0')).toBe(true);
      expect(isPrivateHost('0.1.2.3')).toBe(true);
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

    it('link-local 169.254.x.x（云元数据）', () => {
      expect(isPrivateHost('169.254.0.1')).toBe(true);
      expect(isPrivateHost('169.254.169.254')).toBe(true);
    });

    it('CGNAT 100.64/10', () => {
      expect(isPrivateHost('100.64.0.1')).toBe(true);
      expect(isPrivateHost('100.127.255.255')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:127.0.0.1（含十六进制形式）', () => {
      expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
      // URL 会把 ::ffff:127.0.0.1 规范化为 [::ffff:7f00:1]
      expect(isPrivateHost('[::ffff:7f00:1]')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:10.0.0.1', () => {
      expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    });

    it('IPv4-mapped IPv6 ::ffff:192.168.1.1', () => {
      expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true);
    });

    it('IPv6 link-local fe80::/10', () => {
      expect(isPrivateHost('fe80::1')).toBe(true);
      expect(isPrivateHost('[fe80::1]')).toBe(true);
      expect(isPrivateHost('febf::1')).toBe(true);
      expect(isPrivateHost('fe80::1%eth0')).toBe(true);
    });

    it('IPv6 unique-local fc00::/7', () => {
      expect(isPrivateHost('fc00::1')).toBe(true);
      expect(isPrivateHost('[fd00::1]')).toBe(true);
    });

    it('IPv6 multicast ff00::/8', () => {
      expect(isPrivateHost('ff02::1')).toBe(true);
    });

    it('*.localhost（Chromium 解析到 127.0.0.1）', () => {
      expect(isPrivateHost('x.localhost')).toBe(true);
      expect(isPrivateHost('foo.localhost.')).toBe(true);
    });

    it('6to4 / NAT64 内嵌私网 IPv4', () => {
      expect(isPrivateHost('[2002:7f00:1::]')).toBe(true);
      expect(isPrivateHost('[64:ff9b::7f00:1]')).toBe(true);
    });

    it('IPv4 multicast / reserved 224/4 + 240/4', () => {
      expect(isPrivateHost('224.0.0.1')).toBe(true);
      expect(isPrivateHost('255.255.255.255')).toBe(true);
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

    it('100.63 / 100.128 边界值应通过（不在 64-127 范围）', () => {
      expect(isPrivateHost('100.63.255.255')).toBe(false);
      expect(isPrivateHost('100.128.0.0')).toBe(false);
    });

    it('公网 IPv6', () => {
      expect(isPrivateHost('2001:db8::1')).toBe(false);
      expect(isPrivateHost('[2001:4860:4860::8888]')).toBe(false);
    });

    it('6to4 内嵌公网 IPv4', () => {
      expect(isPrivateHost('[2002:808:808::]')).toBe(false);
    });
  });
});

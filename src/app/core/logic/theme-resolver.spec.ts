import { describe, it, expect } from 'vitest';
import { resolveSchemeColors } from './theme-resolver';

describe('theme-resolver', () => {
  it('returns dark fallback colors when no input', () => {
    const c = resolveSchemeColors('dark');
    expect(c.fg).toBe('#666666');
    expect(c.bg).toBe('#161819');
  });

  it('returns light fallback colors when no input', () => {
    const c = resolveSchemeColors('light');
    expect(c.fg).toBe('#262626');
    expect(c.bg).toBe('#CDC0A4');
  });

  it('uses provided fontColor/screenBg for dark', () => {
    const c = resolveSchemeColors('dark', '#abcdef', '#123456');
    expect(c.fg).toBe('#abcdef');
    expect(c.bg).toBe('#123456');
  });

  it('uses provided fontColor/screenBg for light', () => {
    const c = resolveSchemeColors('light', '#ffffff', '#000000');
    expect(c.fg).toBe('#ffffff');
    expect(c.bg).toBe('#000000');
  });

  it('falls back when input is not valid hex', () => {
    const c = resolveSchemeColors('dark', 'not-a-color', 'also-not');
    expect(c.fg).toBe('#666666');
    expect(c.bg).toBe('#161819');
  });

  it('partially uses input: fg valid + bg invalid → fg kept, bg fallback', () => {
    const c = resolveSchemeColors('dark', '#123456', 'invalid');
    expect(c.fg).toBe('#123456');
    expect(c.bg).toBe('#161819');
  });

  it('accepts short hex (3 digits)', () => {
    const c = resolveSchemeColors('light', '#fff', '#000');
    expect(c.fg).toBe('#fff');
    expect(c.bg).toBe('#000');
  });

  it('accepts 8-digit hex with alpha', () => {
    const c = resolveSchemeColors('dark', '#ffffff80', '#000000ff');
    expect(c.fg).toBe('#ffffff80');
    expect(c.bg).toBe('#000000ff');
  });
});
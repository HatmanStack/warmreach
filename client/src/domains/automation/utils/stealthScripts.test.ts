import { describe, it, expect } from 'vitest';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
  getHeadlessEvasionScript,
} from './stealthScripts';

describe('stealthScripts', () => {
  describe('getCanvasNoiseScript', () => {
    it('requires a seed parameter', () => {
      // @ts-ignore
      const script = getCanvasNoiseScript(12345);
      expect(script).toContain('12345');
    });

    it('is deterministic for the same seed', () => {
      const script1 = getCanvasNoiseScript(12345);
      const script2 = getCanvasNoiseScript(12345);
      expect(script1).toBe(script2);
    });

    it('is different for different seeds', () => {
      const script1 = getCanvasNoiseScript(12345);
      const script2 = getCanvasNoiseScript(54321);
      expect(script1).not.toBe(script2);
    });

    it('embeds a PRNG and does not use Math.random() for noise', () => {
      const script = getCanvasNoiseScript(12345);
      expect(script).not.toContain('Math.random()');
    });
  });

  describe('getWebGLSpoofScript', () => {
    it('requires a GPU profile parameter', () => {
      const profile = { vendor: 'CustomVendor', renderer: 'CustomRenderer' };
      const script = getWebGLSpoofScript(profile);
      expect(script).toContain('CustomVendor');
      expect(script).toContain('CustomRenderer');
      expect(script).not.toContain('gpuProfiles');
    });
  });

  describe('getAudioNoiseScript', () => {
    it('requires a seed parameter', () => {
      const script = getAudioNoiseScript(12345);
      expect(script).toContain('12345');
    });

    it('is deterministic for the same seed', () => {
      const script1 = getAudioNoiseScript(12345);
      const script2 = getAudioNoiseScript(12345);
      expect(script1).toBe(script2);
    });

    it('does not use Math.random() for noise', () => {
      const script = getAudioNoiseScript(12345);
      expect(script).not.toContain('Math.random()');
    });
  });

  describe('getHeadlessEvasionScript', () => {
    it('accepts profile options', () => {
      const script = getHeadlessEvasionScript({
        platform: 'Win32',
        language: 'en-US',
        pluginCount: 5,
      });
      expect(script).toContain('Win32');
      expect(script).toContain('en-US');
      // Should find something like [1, 2, 3, 4, 5] or an array of length 5
      expect(script).toContain('Array(5)');
    });

    it('spoofs navigator.platform', () => {
      const script = getHeadlessEvasionScript({ platform: 'Linux x86_64' });
      expect(script).toContain('platform');
      expect(script).toContain('Linux x86_64');
    });

    it('spoofs navigator.language and languages', () => {
      const script = getHeadlessEvasionScript({ language: 'en-GB' });
      expect(script).toContain('language');
      expect(script).toContain('en-GB');
      expect(script).toContain('en'); // fallback language
    });
  });
});

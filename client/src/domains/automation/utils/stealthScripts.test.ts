import { describe, it, expect } from 'vitest';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
} from './stealthScripts.js';

describe('stealthScripts', () => {
  describe('getCanvasNoiseScript', () => {
    it('returns a non-empty string', () => {
      const script = getCanvasNoiseScript();
      expect(script).toBeTruthy();
      expect(typeof script).toBe('string');
    });

    it('returns valid JavaScript', () => {
      expect(() => new Function(getCanvasNoiseScript())).not.toThrow();
    });

    it('wraps toDataURL and toBlob', () => {
      const script = getCanvasNoiseScript();
      expect(script).toContain('toDataURL');
      expect(script).toContain('toBlob');
    });

    it('uses a clone canvas instead of mutating the source', () => {
      const script = getCanvasNoiseScript();
      expect(script).toContain('noisyExport');
      expect(script).toContain("document.createElement('canvas')");
    });

    it('applies noise to R, G, and B channels', () => {
      const script = getCanvasNoiseScript();
      // Loop over 3 channels: for (let ch = 0; ch < 3; ch++)
      expect(script).toContain('ch < 3');
    });
  });

  describe('getWebGLSpoofScript', () => {
    it('returns a non-empty string', () => {
      const script = getWebGLSpoofScript();
      expect(script).toBeTruthy();
      expect(typeof script).toBe('string');
    });

    it('returns valid JavaScript', () => {
      expect(() => new Function(getWebGLSpoofScript())).not.toThrow();
    });

    it('intercepts UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL', () => {
      const script = getWebGLSpoofScript();
      expect(script).toContain('0x9245');
      expect(script).toContain('0x9246');
    });

    it('uses a pool of GPU profiles selected randomly', () => {
      const script = getWebGLSpoofScript();
      expect(script).toContain('gpuProfiles');
      expect(script).toContain('Math.random()');
    });

    it('includes modern GPU models', () => {
      const script = getWebGLSpoofScript();
      expect(script).toContain('RTX 3060');
      expect(script).toContain('RTX 4070');
      expect(script).toContain('Radeon RX');
    });

    it('handles both WebGL1 and WebGL2 contexts', () => {
      const script = getWebGLSpoofScript();
      expect(script).toContain('WebGLRenderingContext');
      expect(script).toContain('WebGL2RenderingContext');
    });
  });

  describe('getAudioNoiseScript', () => {
    it('returns a non-empty string', () => {
      const script = getAudioNoiseScript();
      expect(script).toBeTruthy();
      expect(typeof script).toBe('string');
    });

    it('returns valid JavaScript', () => {
      expect(() => new Function(getAudioNoiseScript())).not.toThrow();
    });

    it('wraps OfflineAudioContext.startRendering', () => {
      const script = getAudioNoiseScript();
      expect(script).toContain('OfflineAudioContext');
      expect(script).toContain('startRendering');
    });
  });
});

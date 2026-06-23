import { describe, it, expect } from 'vitest';
import {
  getCanvasNoiseScript,
  getWebGLSpoofScript,
  getAudioNoiseScript,
  getHeadlessEvasionScript,
} from './stealthScripts';

/**
 * Build a minimal mock canvas DOM and evaluate the generated canvas-noise script
 * inside it. The client test environment is `node` (no jsdom), so we model just
 * enough of HTMLCanvasElement / 2d context to observe whether the noise lands in
 * the serialized output and whether the source canvas is left untouched.
 *
 * @param seed noise seed
 * @param opts.throwOnGetImageData simulate a cross-origin SecurityError
 */
function evalCanvasScript(
  seed: number,
  opts: { throwOnGetImageData?: boolean } = {}
): { serialize: () => string; sourcePixels: number[] } {
  const sourceFill = 100;
  const size = 4;

  class MockCtx {
    canvas: MockCanvas;
    constructor(canvas: MockCanvas) {
      this.canvas = canvas;
    }
    drawImage(source: MockCanvas) {
      this.canvas._pixels = source._pixels.slice();
    }
    getImageData(_x: number, _y: number, w: number, h: number) {
      if (opts.throwOnGetImageData) {
        const err = new Error('SecurityError');
        err.name = 'SecurityError';
        throw err;
      }
      return { data: this.canvas._pixels, width: w, height: h };
    }
    putImageData(imageData: { data: Uint8ClampedArray }) {
      this.canvas._pixels = imageData.data;
    }
  }

  class MockCanvas {
    width = size;
    height = size;
    _pixels: Uint8ClampedArray = new Uint8ClampedArray(size * size * 4).fill(sourceFill);
    getContext() {
      return new MockCtx(this);
    }
    // Prototype serialization methods that read the (possibly cloned) backing store.
    toDataURL() {
      return 'data:' + Array.from(this._pixels).join(',');
    }
    toBlob(cb: (blob: { pixels: number[] }) => void) {
      cb({ pixels: Array.from(this._pixels) });
    }
  }

  const document = { createElement: () => new MockCanvas() };
  const script = getCanvasNoiseScript(seed);
  const runner = new Function(
    'HTMLCanvasElement',
    'document',
    'Math',
    'Reflect',
    'Proxy',
    'Uint8ClampedArray',
    script
  );
  runner(MockCanvas, document, Math, Reflect, Proxy, Uint8ClampedArray);

  const source = new MockCanvas();
  return {
    serialize: () => source.toDataURL(),
    sourcePixels: Array.from(source._pixels),
  };
}

/**
 * Evaluate the headless-evasion script against a mock navigator whose prototype
 * exposes (empty) plugins/mimeTypes so the spoof branch executes.
 */
function evalHeadlessScript(pluginCount: number): {
  plugins: unknown[];
  mimeTypes: unknown[];
} {
  const navProto: Record<string, unknown> = {};
  const navigator = Object.create(navProto) as {
    plugins: unknown[];
    mimeTypes: unknown[];
    permissions: { query: () => Promise<unknown> };
  };
  Object.defineProperty(navProto, 'plugins', { get: () => [], configurable: true });
  Object.defineProperty(navProto, 'mimeTypes', { get: () => [], configurable: true });
  navigator.permissions = { query: () => Promise.resolve({ state: 'granted' }) };
  const window: { navigator: typeof navigator; chrome?: unknown } = { navigator };

  const script = getHeadlessEvasionScript({ pluginCount });
  const runner = new Function(
    'navigator',
    'window',
    'Object',
    'Promise',
    'Reflect',
    'Proxy',
    'Array',
    'JSON',
    script
  );
  runner(navigator, window, Object, Promise, Reflect, Proxy, Array, JSON);
  return { plugins: navigator.plugins, mimeTypes: navigator.mimeTypes };
}

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

    it('applies deterministic noise to the serialized output for a fixed seed', () => {
      const a = evalCanvasScript(12345).serialize();
      const b = evalCanvasScript(12345).serialize();
      expect(a).toBe(b);
    });

    it('produces different serialized output across different seeds', () => {
      const a = evalCanvasScript(12345).serialize();
      const c = evalCanvasScript(54321).serialize();
      expect(a).not.toBe(c);
    });

    it('actually injects noise (output differs from the un-noised source)', () => {
      const result = evalCanvasScript(12345);
      const plain = 'data:' + result.sourcePixels.join(',');
      expect(result.serialize()).not.toBe(plain);
    });

    it('serializes the noised clone without mutating the source canvas', () => {
      const result = evalCanvasScript(12345);
      // The source canvas pixels are untouched; only the clone carries noise.
      expect(result.sourcePixels.every((v) => v === 100)).toBe(true);
    });

    it('falls back to an un-noised clone on cross-origin SecurityError without throwing', () => {
      const result = evalCanvasScript(12345, { throwOnGetImageData: true });
      const plain = 'data:' + result.sourcePixels.join(',');
      // No noise could be applied, but serialization still succeeds and yields the
      // un-noised pixels rather than throwing.
      expect(result.serialize()).toBe(plain);
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

    it('does not expose mimeTypes as the identical array reference as plugins', () => {
      const { plugins, mimeTypes } = evalHeadlessScript(3);
      // Real browsers have related-but-distinct plugin/mimeType structures;
      // returning the same array is a textbook anti-bot tell.
      expect(mimeTypes).not.toBe(plugins);
    });

    it('exposes a plausible, distinct mimeTypes structure derived from plugins', () => {
      const { plugins, mimeTypes } = evalHeadlessScript(3);
      expect(Array.isArray(mimeTypes)).toBe(true);
      expect(mimeTypes.length).toBeGreaterThan(0);
      // mimeType entries are not byte-identical to plugin entries.
      expect(JSON.stringify(mimeTypes)).not.toBe(JSON.stringify(plugins));
      // ...but they reference the plugins (plausible relationship).
      const first = mimeTypes[0] as Record<string, unknown>;
      expect(first).toHaveProperty('type');
      expect(first).toHaveProperty('enabledPlugin');
    });
  });
});

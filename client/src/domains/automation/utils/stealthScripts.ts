/**
 * Browser fingerprint noise injection scripts.
 * Each function returns a string to be passed to page.evaluateOnNewDocument().
 * The noise is imperceptible to users but changes fingerprint hashes per session.
 */

const MULBERRY32_INLINE = `
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
`;

/**
 * Canvas fingerprint noise: wraps toDataURL and toBlob to add ±1 noise
 * to a small number of random pixel RGB values before hashing.
 * Uses a temporary canvas clone so the source canvas is never mutated.
 * @param seed Seed for deterministic noise
 */
export function getCanvasNoiseScript(seed: number): string {
  return `(() => {
    ${MULBERRY32_INLINE}
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;

    function noisyExport(source) {
      const rng = mulberry32(${seed});
      const clone = document.createElement('canvas');
      clone.width = source.width;
      clone.height = source.height;
      const ctx = clone.getContext('2d');
      if (!ctx) return clone;
      ctx.drawImage(source, 0, 0);
      try {
        const imageData = ctx.getImageData(0, 0, clone.width, clone.height);
        const data = imageData.data;
        // Modify R, G, B of 10 random pixels (skip A to avoid transparency artifacts)
        for (let i = 0; i < 10; i++) {
          const idx = Math.floor(rng() * (data.length / 4)) * 4;
          for (let ch = 0; ch < 3; ch++) {
            data[idx + ch] = Math.max(0, Math.min(255, data[idx + ch] + (rng() > 0.5 ? 1 : -1)));
          }
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        // SecurityError on cross-origin canvases — return un-noised clone
      }
      return clone;
    }

    HTMLCanvasElement.prototype.toDataURL = new Proxy(origToDataURL, {
      apply(target, ctx, args) {
        return Reflect.apply(target, noisyExport(ctx) || ctx, args);
      }
    });

    HTMLCanvasElement.prototype.toBlob = new Proxy(origToBlob, {
      apply(target, ctx, args) {
        return Reflect.apply(target, noisyExport(ctx) || ctx, args);
      }
    });
  })()`;
}

/**
 * WebGL fingerprint spoofing: intercepts getParameter to return plausible
 * vendor/renderer strings.
 * @param gpuProfile GPU vendor and renderer to spoof
 */
export function getWebGLSpoofScript(gpuProfile: { vendor: string; renderer: string }): string {
  return `(() => {
    const profile = ${JSON.stringify(gpuProfile)};

    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = new Proxy(getParam, {
      apply(target, ctx, args) {
        const param = args[0];
        if (param === 0x9245) return profile.vendor;
        if (param === 0x9246) return profile.renderer;
        return Reflect.apply(target, ctx, args);
      }
    });

    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = new Proxy(getParam2, {
        apply(target, ctx, args) {
          const param = args[0];
          if (param === 0x9245) return profile.vendor;
          if (param === 0x9246) return profile.renderer;
          return Reflect.apply(target, ctx, args);
        }
      });
    }
  })()`;
}

/**
 * AudioContext fingerprint noise: wraps OfflineAudioContext.startRendering
 * to add micro-noise (±0.0001) to output buffer samples.
 * @param seed Seed for deterministic noise
 */
export function getAudioNoiseScript(seed: number): string {
  return `(() => {
    if (typeof OfflineAudioContext === 'undefined') return;
    ${MULBERRY32_INLINE}

    const origStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = new Proxy(origStartRendering, {
      apply(target, ctx, args) {
        return Reflect.apply(target, ctx, args).then(buffer => {
          const rng = mulberry32(${seed});
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i += 100) {
              data[i] += (rng() - 0.5) * 0.0002;
            }
          }
          return buffer;
        });
      }
    });
  })()`;
}

/**
 * Custom headless browser evasion.
 * Spoofs common headless indicators (navigator.webdriver, window.chrome, permissions)
 * transparently to avoid detection by advanced bot scripts that flag puppeteer-extra-plugin-stealth.
 * @param options Profile data for spoofing
 */
export function getHeadlessEvasionScript(
  options: {
    platform?: string;
    language?: string;
    pluginCount?: number;
  } = {}
): string {
  const { platform = 'Win32', language = 'en-US', pluginCount = 3 } = options;

  return `(() => {
    // 1. Spoof navigator.webdriver safely
    Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
      get: () => false,
    });

    // 2. Spoof window.chrome (essential for Chromium-based browsers)
    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
    }

    // 3. Spoof Permissions API (headless usually returns 'prompt' for notifications)
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = new Proxy(originalQuery, {
      apply(target, ctx, args) {
        if (args && args.length > 0 && args[0].name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null });
        }
        return Reflect.apply(target, ctx, args);
      }
    });

    // 4. Spoof plugins and mimeTypes (headless often has none)
    if (navigator.plugins.length !== ${pluginCount}) {
      const plugins = Array(${pluginCount}).fill(0).map((_, i) => ({
        name: 'Plugin ' + i,
        description: 'Spoofed Plugin ' + i,
        filename: 'plugin' + i + '.dll'
      }));
      Object.defineProperty(Object.getPrototypeOf(navigator), 'plugins', {
        get: () => plugins,
      });
      Object.defineProperty(Object.getPrototypeOf(navigator), 'mimeTypes', {
        get: () => plugins,
      });
    }

    // 5. Spoof navigator.platform
    Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
      get: () => ${JSON.stringify(platform)},
    });

    // 6. Spoof navigator.language and languages
    Object.defineProperty(Object.getPrototypeOf(navigator), 'language', {
      get: () => ${JSON.stringify(language)},
    });
    Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', {
      get: () => [${JSON.stringify(language)}, ${JSON.stringify(language.split('-')[0])}],
    });
  })()`;
}

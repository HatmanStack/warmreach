/**
 * Browser fingerprint noise injection scripts.
 * Each function returns a string to be passed to page.evaluateOnNewDocument().
 * The noise is imperceptible to users but changes fingerprint hashes per session.
 */

/**
 * Canvas fingerprint noise: wraps toDataURL and toBlob to add ±1 noise
 * to a small number of random pixel RGB values before hashing.
 * Uses a temporary canvas clone so the source canvas is never mutated.
 */
export function getCanvasNoiseScript(): string {
  return `(() => {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;

    function noisyExport(source) {
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
          const idx = Math.floor(Math.random() * (data.length / 4)) * 4;
          for (let ch = 0; ch < 3; ch++) {
            data[idx + ch] = Math.max(0, Math.min(255, data[idx + ch] + (Math.random() > 0.5 ? 1 : -1)));
          }
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        // SecurityError on cross-origin canvases — return un-noised clone
      }
      return clone;
    }

    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      return origToDataURL.apply(noisyExport(this), args);
    };

    HTMLCanvasElement.prototype.toBlob = function(callback, ...rest) {
      return origToBlob.call(noisyExport(this), callback, ...rest);
    };
  })()`;
}

/**
 * WebGL fingerprint spoofing: intercepts getParameter to return plausible
 * vendor/renderer strings. A random GPU profile is selected once per session
 * from a pool of common modern configurations.
 */
export function getWebGLSpoofScript(): string {
  return `(() => {
    const gpuProfiles = [
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
    ];
    const profile = gpuProfiles[Math.floor(Math.random() * gpuProfiles.length)];

    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      // UNMASKED_VENDOR_WEBGL
      if (param === 0x9245) return profile.vendor;
      // UNMASKED_RENDERER_WEBGL
      if (param === 0x9246) return profile.renderer;
      return getParam.call(this, param);
    };

    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) return profile.vendor;
        if (param === 0x9246) return profile.renderer;
        return getParam2.call(this, param);
      };
    }
  })()`;
}

/**
 * AudioContext fingerprint noise: wraps OfflineAudioContext.startRendering
 * to add micro-noise (±0.0001) to output buffer samples.
 */
export function getAudioNoiseScript(): string {
  return `(() => {
    if (typeof OfflineAudioContext === 'undefined') return;

    const origStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function() {
      return origStartRendering.call(this).then(buffer => {
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const data = buffer.getChannelData(ch);
          for (let i = 0; i < data.length; i += 100) {
            data[i] += (Math.random() - 0.5) * 0.0002;
          }
        }
        return buffer;
      });
    };
  })()`;
}

/**
 * Type declarations for puppeteer-extra and puppeteer-extra-plugin-stealth.
 *
 * These packages export CJS modules with .d.ts files that don't resolve
 * correctly under TypeScript's NodeNext module resolution. This shim
 * re-declares the default exports so ESM imports work.
 */

declare module 'puppeteer-extra' {
  import type { PuppeteerNode } from 'puppeteer';

  interface PuppeteerExtraPlugin {
    _isPuppeteerExtraPlugin: boolean;
    [propName: string]: unknown;
  }

  interface PuppeteerExtra {
    use(plugin: PuppeteerExtraPlugin): PuppeteerExtra;
    launch(options?: Parameters<PuppeteerNode['launch']>[0]): ReturnType<PuppeteerNode['launch']>;
    connect(options: Parameters<PuppeteerNode['connect']>[0]): ReturnType<PuppeteerNode['connect']>;
  }

  const puppeteer: PuppeteerExtra;
  export default puppeteer;
}

declare module 'puppeteer-extra-plugin-stealth' {
  import type { PuppeteerExtraPlugin } from 'puppeteer-extra';

  function StealthPlugin(opts?: { enabledEvasions?: Set<string> }): PuppeteerExtraPlugin;

  export default StealthPlugin;
}

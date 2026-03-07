import { describe, it, expect } from 'vitest';
import type { SelectorRegistry, SelectorCascade, SelectorStrategy } from './selectorRegistry';

describe('selectorRegistry types', () => {
  it('should allow defining registry objects', () => {
    // This is a type-only test to ensure the file can be imported and types work
    const strategy: SelectorStrategy = { strategy: 'css', selector: '.test' };
    const cascade: SelectorCascade = [strategy];
    const registry: SelectorRegistry = { 'test:key': cascade };

    expect(registry['test:key']).toBeDefined();
    expect(registry['test:key'][0].selector).toBe('.test');
  });
});

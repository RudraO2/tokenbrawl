import { describe, expect, it } from 'vitest';
import { placeholder } from './main';

describe('@tokenbrawl/web placeholder', () => {
  it('exports a truthy placeholder', () => {
    expect(placeholder).toBe(true);
  });
});

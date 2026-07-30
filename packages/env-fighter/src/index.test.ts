import { describe, expect, it } from 'vitest';
import { placeholder } from './index';

describe('@tokenbrawl/env-fighter placeholder', () => {
  it('exports a truthy placeholder', () => {
    expect(placeholder).toBe(true);
  });
});

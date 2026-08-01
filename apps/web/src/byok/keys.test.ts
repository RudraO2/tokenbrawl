import { describe, expect, it } from 'vitest';
import { createKeyStore, redact, type KeyStorage } from './keys';

/**
 * Story 4.6 AC2, the local half: "storing a key in localStorage requires an
 * explicit opt-in from the visitor. Default is not to persist."
 *
 * The server half needs no test because it needs no code: the site is static
 * and there is nowhere to send a key to (INV-8). What is testable is that this
 * store writes only when asked, forgets completely, and survives a storage that
 * throws.
 */

function createFakeStorage(): KeyStorage & { readonly entries: () => ReadonlyMap<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries: () => entries,
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
    },
    removeItem: (key: string): void => {
      entries.delete(key);
    },
  };
}

describe('keys are not persisted unless the visitor asks (AC2)', () => {
  it('writes nothing when nothing asked it to', () => {
    const storage = createFakeStorage();
    const store = createKeyStore(storage);
    expect(store.load()).toStrictEqual(['', '']);
    expect(store.persisted()).toBe(false);
    expect(storage.entries().size).toBe(0);
  });

  it('round-trips a pair once saved', () => {
    const storage = createFakeStorage();
    const store = createKeyStore(storage);
    store.save(['gsk-one', 'csk-two']);
    expect(store.persisted()).toBe(true);
    expect(createKeyStore(storage).load()).toStrictEqual(['gsk-one', 'csk-two']);
  });

  it('forgets completely, leaving nothing behind', () => {
    const storage = createFakeStorage();
    const store = createKeyStore(storage);
    store.save(['gsk-one', 'csk-two']);
    store.forget();
    expect(storage.entries().size).toBe(0);
    expect(store.persisted()).toBe(false);
    expect(store.load()).toStrictEqual(['', '']);
  });

  it('keeps the two keys apart even when one is empty', () => {
    // One key filled and one blank is the state of the form while a visitor is
    // still typing, and it is the state most likely to be saved by accident.
    const storage = createFakeStorage();
    const store = createKeyStore(storage);
    store.save(['gsk-only', '']);
    expect(store.load()).toStrictEqual(['gsk-only', '']);
  });

  it('works with no storage at all, which is a tab with storage disabled', () => {
    const store = createKeyStore(undefined);
    store.save(['gsk-one', 'csk-two']);
    expect(store.load()).toStrictEqual(['', '']);
    expect(store.persisted()).toBe(false);
  });

  it('survives a storage that throws, rather than taking the Match down with it', () => {
    // Safari's private mode throws on `setItem` with a zero quota, and a tab
    // with third-party storage blocked throws on access. Ticking a checkbox
    // must not be able to raise an exception into the run path.
    const hostile: KeyStorage = {
      getItem: (): string | null => {
        throw new Error('storage is blocked');
      },
      setItem: (): void => {
        throw new Error('quota exceeded');
      },
      removeItem: (): void => {
        throw new Error('storage is blocked');
      },
    };
    const store = createKeyStore(hostile);
    expect(() => {
      store.save(['gsk-one', 'csk-two']);
    }).not.toThrow();
    expect(() => {
      store.forget();
    }).not.toThrow();
    expect(store.load()).toStrictEqual(['', '']);
  });
});

describe('redaction, the last gate before provider text reaches the page', () => {
  it('removes a key a provider quoted back', () => {
    const body = 'Incorrect API key provided: gsk_abcdefghijklmnop. You can find your key at ...';
    expect(redact(body, ['gsk_abcdefghijklmnop'])).not.toContain('gsk_abcdefghijklmnop');
    expect(redact(body, ['gsk_abcdefghijklmnop'])).toContain('[key redacted]');
  });

  it('removes every occurrence, not just the first', () => {
    const redacted = redact('gsk_abcdefghijklmnop and again gsk_abcdefghijklmnop', [
      'gsk_abcdefghijklmnop',
    ]);
    expect(redacted).toBe('[key redacted] and again [key redacted]');
  });

  it('removes both fighters\' keys from one message', () => {
    const redacted = redact('first gsk_aaaaaaaaaaaa second csk_bbbbbbbbbbbb', [
      'gsk_aaaaaaaaaaaa',
      'csk_bbbbbbbbbbbb',
    ]);
    expect(redacted).toBe('first [key redacted] second [key redacted]');
  });

  it('ignores a secret too short to be one, so the message stays readable', () => {
    // A single character would otherwise redact most of the sentence that tells
    // the visitor what went wrong.
    expect(redact('the model was not found', ['a'])).toBe('the model was not found');
    expect(redact('the model was not found', [''])).toBe('the model was not found');
  });

  it('treats a key with surrounding whitespace as the same key', () => {
    // A pasted key routinely carries a trailing newline, and the untrimmed form
    // would then never match the trimmed one the request actually carried.
    expect(redact('rejected gsk_abcdefghijklmnop', ['  gsk_abcdefghijklmnop\n'])).toContain(
      '[key redacted]',
    );
  });
});

/**
 * Story 4.6, AC2: where a visitor's keys live, and the one condition under
 * which they outlive the tab.
 *
 * The default is memory. `localStorage` is written only after an explicit
 * opt-in, which is the story's own rule and not a preference -- a page that
 * quietly persisted a provider credential would be doing the one thing a
 * visitor pasting one into a stranger's site is entitled to assume it does not.
 *
 * There is no server side to this and there cannot be (INV-8): the whole site
 * is static, so "never persisted to any server" is a property of the
 * architecture rather than of this file. What this file owns is the *local*
 * half, plus redaction -- the last gate before any provider text reaches the
 * page.
 */

/** The slice of `Storage` this needs. Structural, so a test needs no DOM. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeyStore {
  /** The remembered pair, or two empty strings. Never throws: storage can be disabled or full. */
  readonly load: () => readonly [string, string];
  /** Writes the pair. Only ever called from the opt-in path. */
  readonly save: (keys: readonly [string, string]) => void;
  readonly forget: () => void;
  readonly persisted: () => boolean;
}

/** One key, so unticking the box removes everything this app ever wrote. */
const STORAGE_KEY = 'tokenbrawl.byok.keys';

/**
 * Keys are stored as two lines rather than as JSON.
 *
 * A key with a newline in it is not a key any provider issues, and splitting on
 * the first newline cannot be confused by a value that happens to look like
 * JSON. It also keeps what is written obvious to anyone who opens their own
 * devtools to check what this page kept.
 */
function encode(keys: readonly [string, string]): string {
  return `${keys[0]}\n${keys[1]}`;
}

function decode(stored: string): readonly [string, string] {
  const newline = stored.indexOf('\n');
  return newline < 0 ? [stored, ''] : [stored.slice(0, newline), stored.slice(newline + 1)];
}

/**
 * Builds the store over whatever storage it is handed.
 *
 * Every call is wrapped: `localStorage` throws on access in a tab with
 * third-party storage blocked, and in Safari's private mode `setItem` throws
 * when the quota is zero. A visitor who ticked a box should not lose their
 * Match to an exception raised by the box.
 */
export function createKeyStore(storage?: KeyStorage): KeyStore {
  const read = (): string | null => {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };

  return Object.freeze({
    load: (): readonly [string, string] => {
      const stored = read();
      return stored === null ? ['', ''] : decode(stored);
    },
    save: (keys: readonly [string, string]): void => {
      try {
        storage?.setItem(STORAGE_KEY, encode(keys));
      } catch {
        // Nothing to do and nothing worth saying: the keys still work for this
        // Match, and the only thing lost is the convenience that was opted into.
      }
    },
    forget: (): void => {
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        // As above.
      }
    },
    persisted: (): boolean => read() !== null,
  });
}

/** Long enough that a short prefix cannot be a whole key, short enough to catch a truncated paste. */
const MIN_REDACTABLE = 8;

/**
 * Removes every supplied secret from a string.
 *
 * Applied to provider error text before it is shown, because providers do quote
 * the offending credential back -- an invalid-key body that echoes the key is
 * the normal shape of that response, and this page puts that body on screen.
 *
 * Short and blank secrets are ignored on purpose. A one-character "key" would
 * otherwise redact most of the message and leave the visitor with a row of
 * blocks instead of the sentence that tells them what went wrong.
 */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => {
    const trimmed = secret.trim();
    if (trimmed.length < MIN_REDACTABLE) {
      return redacted;
    }
    return redacted.split(trimmed).join('[key redacted]');
  }, text);
}

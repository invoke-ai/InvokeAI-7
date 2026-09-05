/**
 * Generate an RFC 4122 version 4 UUID.
 *
 * `crypto.randomUUID` is exposed only in secure contexts — HTTPS, or `localhost`
 * over plain HTTP. The app is routinely opened from another device on the LAN
 * (an iPad pointed at a workstation, say), and there the property is simply
 * undefined, so a bare `crypto.randomUUID()` throws. The durable persistence
 * layer mints a writer token during startup, which turned that into a crash
 * before first paint.
 *
 * `crypto.getRandomValues` carries no secure-context restriction, so when the
 * native generator is missing the UUID is assembled from sixteen random bytes
 * with the version and variant bits set by hand. Every call site that needs a
 * fresh id goes through here; `crypto.randomUUID` must not be called directly.
 */

/** The subset of `Crypto` the generator relies on, so tests can swap it. */
export type UuidCryptoSource = Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>;

const toHex = (byte: number): string => byte.toString(16).padStart(2, '0');

export const createUuidWith = (source: UuidCryptoSource): string => {
  if (typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }

  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  // Version 4: the top nibble of byte 6 is 0b0100.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // RFC 4122 variant: the top two bits of byte 8 are 0b10.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, toHex).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createUuid = (): string => createUuidWith(globalThis.crypto);

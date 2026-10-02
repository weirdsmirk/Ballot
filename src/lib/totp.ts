/**
 * Time-based one-time passwords (RFC 6238) and base32 secret handling.
 *
 * Implemented directly on `node:crypto` so the project keeps its zero-runtime-
 * dependency posture. Only the standard HMAC-SHA1 variant with a six digit code
 * and a thirty second step is supported, which is what authenticator apps
 * produce by default.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DIGITS = 6
const PERIOD_SECONDS = 30
/** Accept one step either side to tolerate clock drift. */
const WINDOW = 1

export function base32Encode(buffer: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error('Invalid base32 secret')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** A fresh 20 byte secret, base32 encoded as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** `otpauth://` URI for rendering as a QR code. */
export function totpUri(secret: string, account: string, issuer = 'Ballot'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function currentTotp(secret: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD_SECONDS))
}

export function verifyTotp(secret: string, token: string, atMs: number = Date.now()): boolean {
  const cleaned = token.replace(/\D/g, '')
  if (cleaned.length !== DIGITS) return false
  const secretBuffer = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS)
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = hotp(secretBuffer, counter + drift)
    if (
      expected.length === cleaned.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))
    ) {
      return true
    }
  }
  return false
}

/* ------------------------------------------------------ recovery codes --- */

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Single-use recovery codes.
 *
 * These exist so an administrator locked out by a lost authenticator is not
 * permanently locked out of the platform. Only the hashes are stored, so a
 * database leak does not hand over working codes.
 */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8)
    let code = ''
    for (let index = 0; index < 8; index += 1) {
      if (index === 4) code += '-'
      code += RECOVERY_ALPHABET[bytes[index] % RECOVERY_ALPHABET.length]
    }
    return code
  })
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function hashRecoveryCode(code: string, salt: string): string {
  return createHmac('sha256', salt).update(normaliseRecoveryCode(code)).digest('base64url')
}

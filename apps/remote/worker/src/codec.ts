// SPDX-License-Identifier: Apache-2.0
/**
 * Pure encoding helpers: base64url, constant-time comparison, cookies.
 * Nothing here touches Request, Env or fetch, so it is trivially testable.
 */

/** Unpadded base64url of `bytes`. */
export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decode unpadded base64url, or null when the input is malformed. */
export function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = padded.length % 4;
  if (remainder === 1) {
    return null;
  }
  const withPadding = remainder === 0 ? padded : `${padded}${"=".repeat(4 - remainder)}`;
  let binary: string;
  try {
    binary = atob(withPadding);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Constant-time byte comparison. Lengths are not secret here (both sides
 * are signature-sized), so a length mismatch ends early.
 */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] as number ^ (right[i] as number);
  }
  return diff === 0;
}

/** Parse a Cookie header into name/value pairs. First name wins. */
export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(name in cookies)) {
      cookies[name] = value;
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Build a Set-Cookie value. Values are the relay's own tokens, never quoted. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path !== undefined) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly === true) {
    parts.push("HttpOnly");
  }
  if (options.secure === true) {
    parts.push("Secure");
  }
  if (options.sameSite !== undefined) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  return parts.join("; ");
}

// SPDX-License-Identifier: Apache-2.0
// The relay's auth HTTP: who the session cookie says this browser is, and
// signing out of it. The Worker answers 401 without a session cookie,
// 200 {login} with one; POST /auth/logout clears the cookie.

/** The login behind the session cookie, or null when signed out. */
export async function fetchLogin(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl("/auth/me");
  } catch {
    return null;
  }
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body === "object" && body !== null && typeof (body as { login: unknown }).login === "string") {
    return (body as { login: string }).login;
  }
  return null;
}

/** Clear the relay session; throws when the request fails. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl("/auth/logout", { method: "POST" });
  } catch {
    throw new Error("Could not reach the relay");
  }
  if (!res.ok) {
    throw new Error(`Could not sign out (${res.status})`);
  }
}

/**
 * The single place the frontend talks to the backend.
 *
 * Every request goes to a relative path like "/api/lots". In development Vite
 * forwards those to the Fastify server on port 3000 (see vite.config.ts); in
 * production Nginx does the same. The frontend never knows the backend's
 * address, so nothing has to change between the two.
 */

import { CLIENT_ID } from "./liveUpdates";

/** An error the server sent us deliberately, with its HTTP status attached. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** No session — the user needs to sign in again. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but this role is not allowed to do it. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      // Send the session cookie with every request.
      credentials: "include",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        // Which tab is asking. The server puts it on the change it announces so
        // this tab's own stream can skip it — it re-reads when the response
        // lands and does not need telling again. See lib/liveUpdates.ts.
        "X-Client-Id": CLIENT_ID,
        ...init.headers,
      },
    });
  } catch {
    // fetch() only rejects when the request never got an answer at all.
    throw new ApiError(0, "Could not connect to the server. Is it running?");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body = payload as { message?: string; error?: string } | null;
    throw new ApiError(
      response.status,
      body?.message ?? `Error ${response.status}`,
      body?.error,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  // A body on a DELETE is unusual but legal, and it is how the reason for
  // removing a record travels — the same reason an archive sends in its POST.
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};

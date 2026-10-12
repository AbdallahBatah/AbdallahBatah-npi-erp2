const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'npi_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** status 0 = network unreachable (fetch rejected before any HTTP response). */
export class ApiError extends Error {
  /** `body` is the parsed JSON error response when there was one (e.g. a 409's `existing` record). */
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

/**
 * Window event fired when a request outside `/auth/*` answers 403. A 403 on a
 * screen the user could open usually means a permission was withdrawn while
 * the page was open, so the AuthProvider re-reads the session on it (ADR-02
 * §3-5) and the sidebar and page guard catch up at once.
 */
export const FORBIDDEN_EVENT = 'npi:forbidden';

function announceForbidden(path: string) {
  if (typeof window === 'undefined' || path.startsWith('/auth/')) return;
  window.dispatchEvent(new Event(FORBIDDEN_EVENT));
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'Network unreachable');
  }

  if (res.status === 401 && token && !path.startsWith('/auth/')) {
    // Expired/invalid session on an authenticated call: back to login once.
    setToken(null);
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login?expired=1';
    }
    throw new ApiError(401, 'Session expired');
  }

  if (res.status === 403) announceForbidden(path);

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Proxy/gateway HTML page instead of JSON — surface the status, not the parse crash.
    throw new ApiError(res.status, res.statusText || 'Invalid server response');
  }

  if (!res.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : body?.message ?? res.statusText;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  get: <T = any>(path: string) => apiFetch<T>(path),
  post: <T = any>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T = any>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  /** Replaces a collection wholesale, where PATCH would mean "merge into it". */
  put: <T = any>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T = any>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

/** Multipart upload — no Content-Type header: the browser sets the boundary. */
export async function apiUpload<T = any>(path: string, file: File): Promise<T> {
  const token = getToken();
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
  } catch {
    throw new ApiError(0, 'Network unreachable');
  }
  if (res.status === 403) announceForbidden(path);
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, res.statusText || 'Invalid server response');
  }
  if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText);
  return body as T;
}

/** Authenticated file download via blob (the token cannot ride a plain <a href>). */
export async function apiDownload(path: string, fileName: string): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch {
    throw new ApiError(0, 'Network unreachable');
  }
  if (!res.ok) {
    if (res.status === 403) announceForbidden(path);
    let message = res.statusText;
    try {
      message = (await res.json())?.message ?? message;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

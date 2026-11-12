import { logger } from '../logger';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || '/api';
const TOKEN_KEY = 'req_platform_token';

/** 会话失效事件：仅在「持有 token 却收到 401」时派发，登录接口的 401 不触发 */
export const AUTH_EXPIRED_EVENT = 'req-platform:auth-expired';

function notifyAuthExpired() {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

function handleUnauthorized() {
  const hadToken = !!getToken();
  setToken(null);
  if (hadToken) notifyAuthExpired();
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;
  public readonly requestId?: string;

  constructor(
    message: string,
    options: { status: number; code?: string; details?: unknown; requestId?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const log = logger.child({ module: 'api' });
  const token = getToken();

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });

    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: T;
      error?: { code?: string; message?: string; details?: unknown; requestId?: string };
    } | null;

    if (!response.ok || payload?.success === false) {
      const message = payload?.error?.message || `请求失败 (${response.status})`;
      const err = new ApiError(message, {
        status: response.status,
        code: payload?.error?.code,
        details: payload?.error?.details,
        requestId: payload?.error?.requestId ?? requestId,
      });
      if (response.status === 401) {
        handleUnauthorized();
      }
      log.error(message, err, { path, method: options.method ?? 'GET' });
      throw err;
    }

    return (payload?.data ?? payload) as T;
  } catch (error) {
    if (!(error instanceof ApiError)) {
      log.error(`网络请求异常: ${path}`, error, { method: options.method ?? 'GET' });
    }
    throw error;
  }
}

export const api = {
  get: <T>(path: string) => apiRequest<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  download: async (path: string, fallbackFilename: string): Promise<void> => {
    const url = `${API_BASE}${path}`;
    const log = logger.child({ module: 'api' });
    const token = getToken();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message = payload?.error?.message || `下载失败 (${response.status})`;
      if (response.status === 401) handleUnauthorized();
      log.error(message, undefined, { path, method: 'GET' });
      throw new ApiError(message, { status: response.status });
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
    let filename = fallbackFilename;
    if (utf8Match?.[1]) {
      try {
        filename = decodeURIComponent(utf8Match[1].trim());
      } catch {
        filename = utf8Match[1].trim();
      }
    } else if (plainMatch?.[1]) {
      filename = plainMatch[1].trim();
    }
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  },
  upload: async <T>(path: string, file: File, fieldName = 'file'): Promise<T> => {
    const url = `${API_BASE}${path}`;
    const log = logger.child({ module: 'api' });
    const token = getToken();
    const form = new FormData();
    form.append(fieldName, file);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });

    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: T;
      error?: { code?: string; message?: string; details?: unknown; requestId?: string };
    } | null;

    if (!response.ok || payload?.success === false) {
      const message = payload?.error?.message || `上传失败 (${response.status})`;
      const err = new ApiError(message, {
        status: response.status,
        code: payload?.error?.code,
        details: payload?.error?.details,
        requestId: payload?.error?.requestId ?? requestId,
      });
      if (response.status === 401) handleUnauthorized();
      log.error(message, err, { path, method: 'POST' });
      throw err;
    }
    return (payload?.data ?? payload) as T;
  },
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StackLocation {
  file?: string;
  line?: number;
  column?: number;
  functionName?: string;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
  url?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getConfiguredLevel(): LogLevel {
  const raw = (import.meta.env.VITE_LOG_LEVEL as string | undefined)?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'debug';
}

/** 解析浏览器 Error.stack，提取文件 / 行 / 列 */
export function parseBrowserStack(stack?: string): StackLocation {
  if (!stack) return {};

  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.includes('logger') || line.includes('node_modules')) continue;

    // Chrome: at fn (http://host/src/file.tsx:10:5)
    const chrome = line.match(/at\s+(?:(.+?)\s+)?\(?((?:https?|file|webpack|vite)[^)\s]+):(\d+):(\d+)\)?/);
    if (chrome) {
      const file = chrome[2];
      if (file.includes('/logger/')) continue;
      return {
        functionName: chrome[1] || undefined,
        file,
        line: Number(chrome[3]),
        column: Number(chrome[4]),
      };
    }

    // Firefox: fn@http://host/src/file.tsx:10:5
    const firefox = line.match(/^(.*)@(.+):(\d+):(\d+)$/);
    if (firefox) {
      return {
        functionName: firefox[1] || undefined,
        file: firefox[2],
        line: Number(firefox[3]),
        column: Number(firefox[4]),
      };
    }
  }

  return {};
}

function createEntry(
  level: LogLevel,
  message: string,
  error?: unknown,
  context?: Record<string, unknown>,
): LogEntry {
  let stack: string | undefined;
  let location: StackLocation = {};

  if (error instanceof Error) {
    stack = error.stack;
    location = parseBrowserStack(error.stack);
  } else if (error !== undefined) {
    context = { ...context, errorValue: String(error) };
  }

  if (!stack) {
    const probe = new Error('__location__');
    location = parseBrowserStack(probe.stack);
  }

  return {
    level,
    message,
    stack,
    file: location.file,
    line: location.line,
    column: location.column,
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    context: {
      ...context,
      functionName: location.functionName,
    },
    timestamp: new Date().toISOString(),
  };
}

function printToConsole(entry: LogEntry): void {
  const loc = entry.file
    ? ` [${entry.file}${entry.line != null ? `:${entry.line}` : ''}${entry.column != null ? `:${entry.column}` : ''}]`
    : '';
  const prefix = `[${entry.timestamp}] ${entry.level.toUpperCase()}${loc}`;
  const payload = { context: entry.context, stack: entry.stack };

  switch (entry.level) {
    case 'debug':
      console.debug(prefix, entry.message, payload);
      break;
    case 'info':
      console.info(prefix, entry.message, payload);
      break;
    case 'warn':
      console.warn(prefix, entry.message, payload);
      break;
    case 'error':
      console.error(prefix, entry.message, payload);
      break;
  }
}

/** 将日志写入浏览器本地（sessionStorage 环形缓冲），便于开发时导出排查 */
const LOCAL_KEY = 'req_platform_client_logs';
const LOCAL_MAX = 200;

function persistLocally(entry: LogEntry): void {
  try {
    const raw = sessionStorage.getItem(LOCAL_KEY);
    const list: LogEntry[] = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    list.push(entry);
    while (list.length > LOCAL_MAX) list.shift();
    sessionStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    // storage 满或不可用时忽略
  }
}

export function getLocalLogs(): LogEntry[] {
  try {
    const raw = sessionStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearLocalLogs(): void {
  sessionStorage.removeItem(LOCAL_KEY);
}

let queue: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushQueue(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, queue.length);
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string) || '/api';

  try {
    await fetch(`${baseUrl}/client-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logs: batch.map(({ timestamp: _t, ...rest }) => rest),
      }),
      keepalive: true,
    });
  } catch (err) {
    // 上报失败时回填队列，避免丢 error；同时打控制台
    queue = [...batch, ...queue].slice(0, 100);
    console.warn('[logger] 上报日志失败', err);
  }
}

function scheduleFlush(immediate = false): void {
  if (immediate) {
    void flushQueue();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, 800);
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getConfiguredLevel()];
}

function write(level: LogLevel, message: string, error?: unknown, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry = createEntry(level, message, error, context);
  printToConsole(entry);
  persistLocally(entry);

  // warn/error 上报后端；error 立即刷出
  if (level === 'warn' || level === 'error') {
    queue.push(entry);
    scheduleFlush(level === 'error');
  }
}

/**
 * 前端统一日志入口。
 * - 控制台输出（含文件/行号）
 * - sessionStorage 本地环形缓冲
 * - warn/error 批量上报后端（落文件 + error 落库）
 */
export const logger = {
  debug(message: string, context?: Record<string, unknown>) {
    write('debug', message, undefined, context);
  },
  info(message: string, context?: Record<string, unknown>) {
    write('info', message, undefined, context);
  },
  warn(message: string, context?: Record<string, unknown>) {
    write('warn', message, undefined, context);
  },
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    write('error', message, error, context);
  },
  child(defaultMeta: Record<string, unknown>) {
    return {
      debug: (message: string, context?: Record<string, unknown>) =>
        logger.debug(message, { ...defaultMeta, ...context }),
      info: (message: string, context?: Record<string, unknown>) =>
        logger.info(message, { ...defaultMeta, ...context }),
      warn: (message: string, context?: Record<string, unknown>) =>
        logger.warn(message, { ...defaultMeta, ...context }),
      error: (message: string, error?: unknown, context?: Record<string, unknown>) =>
        logger.error(message, error, { ...defaultMeta, ...context }),
    };
  },
  /** 页面卸载前尽量刷出队列 */
  flush: flushQueue,
};

/** 安装全局未捕获错误 / Promise rejection 监听 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    logger.error(event.message || 'window.onerror', event.error ?? new Error(event.message), {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logger.error(
      'unhandledrejection',
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });

  window.addEventListener('beforeunload', () => {
    void logger.flush();
  });
}

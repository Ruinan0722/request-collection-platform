const STORAGE_KEY = 'req:returnTo';

/** 记住列表/来源页，详情返回时恢复筛选与分页 */
export function rememberReturnTo(path: string) {
  if (!path.startsWith('/')) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, path);
  } catch {
    /* ignore quota / private mode */
  }
}

export function readReturnTo(fallback = '/requirements') {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored && stored.startsWith('/')) return stored;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function detailLinkState(from: string) {
  return { from } as const;
}

export function resolveReturnTo(fromState: unknown, fallback = '/requirements') {
  if (typeof fromState === 'string' && fromState.startsWith('/')) {
    return fromState;
  }
  return readReturnTo(fallback);
}

/** 面包屑上来源页文案 */
export function crumbLabel(path: string) {
  if (path === '/' || path.startsWith('/?')) return '工作台';
  if (path.startsWith('/projects/')) return '项目看板';
  if (path.startsWith('/submit')) return '提需求';
  if (path.startsWith('/requirements')) return '需求列表';
  return '上一页';
}

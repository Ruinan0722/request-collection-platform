const STORAGE_KEY_PREFIX = 'req-platform:requirements-list-prefs';
const LEGACY_STORAGE_KEY = 'req-platform:requirements-list-prefs';

export type RequirementsListPrefs = {
  view: 'list' | 'board';
  projectId: string;
  status: string;
  priority: string;
  mine: string;
  claimed: string;
  createdFrom: string;
  createdTo: string;
  dueFrom: string;
  dueTo: string;
};

const DEFAULT_PREFS: RequirementsListPrefs = {
  view: 'list',
  projectId: '',
  status: '',
  priority: '',
  mine: '',
  claimed: '',
  createdFrom: '',
  createdTo: '',
  dueFrom: '',
  dueTo: '',
};

function storageKey(userId?: string | null): string {
  const id = (userId || '').trim();
  return id ? `${STORAGE_KEY_PREFIX}:${id}` : LEGACY_STORAGE_KEY;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function parsePrefs(raw: string | null): RequirementsListPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(raw) as Partial<RequirementsListPrefs>;
    return {
      view: parsed.view === 'board' ? 'board' : 'list',
      projectId: asString(parsed.projectId),
      status: asString(parsed.status),
      priority: asString(parsed.priority),
      mine: asString(parsed.mine),
      claimed: parsed.claimed === '1' ? '1' : '',
      createdFrom: asString(parsed.createdFrom),
      createdTo: asString(parsed.createdTo),
      dueFrom: asString(parsed.dueFrom),
      dueTo: asString(parsed.dueTo),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 按登录用户隔离筛选偏好，避免切账号后仍沿用上一账号的状态过滤。 */
export function readRequirementsListPrefs(userId?: string | null): RequirementsListPrefs {
  try {
    const keyed = localStorage.getItem(storageKey(userId));
    if (keyed) return parsePrefs(keyed);
    // 无用户维度缓存时不回落全局旧 key，避免串号
    if (userId) return { ...DEFAULT_PREFS };
    return parsePrefs(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeRequirementsListPrefs(
  prefs: RequirementsListPrefs,
  userId?: string | null,
) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    // ignore quota / private mode failures
  }
}

/** 仅补全 URL 里尚未出现的筛选项，显式 query 优先。 */
export function mergeRequirementsListPrefs(
  params: URLSearchParams,
  prefs: RequirementsListPrefs,
): URLSearchParams | null {
  const next = new URLSearchParams(params);
  let changed = false;

  const fill = (key: keyof RequirementsListPrefs, value: string) => {
    if (params.has(key) || !value) return;
    next.set(key, value);
    changed = true;
  };

  if (!params.has('view') && prefs.view === 'board') {
    next.set('view', 'board');
    changed = true;
  }

  fill('projectId', prefs.projectId);
  fill('status', prefs.status);
  fill('priority', prefs.priority);
  // 兼容旧「接取」筛选：不再恢复 claimed
  if (prefs.mine === 'unassigned' || prefs.mine === 'mine') {
    // 旧「接单/我负责」参数不再自动恢复
  } else {
    fill('mine', prefs.mine);
  }
  fill('createdFrom', prefs.createdFrom);
  fill('createdTo', prefs.createdTo);
  fill('dueFrom', prefs.dueFrom);
  fill('dueTo', prefs.dueTo);

  return changed ? next : null;
}

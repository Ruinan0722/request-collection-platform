import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, AUTH_EXPIRED_EVENT, getToken, setToken } from '../api/client';
import { toast } from '../toast';
import { logger } from '../logger';

/** 会话过期标记：登录页读取后展示横幅并清除（避免受路由重定向竞态影响） */
export const SESSION_EXPIRED_KEY = 'req-platform:session-expired';

export type UserRole = 'requester' | 'executor';

export interface AuthUser {
  id: string;
  name: string;
  role: UserRole;
  avatarUrl?: string | null;
  email?: string | null;
  departmentIds?: string[];
  departmentNames?: string[];
  roleSource?: string;
  roleLocked?: boolean;
}

interface DevPreset {
  key: string;
  name: string;
  role: UserRole;
  label: string;
  hint: string;
}

interface AuthConfig {
  feishuEnabled: boolean;
  devLoginEnabled: boolean;
  authorizeUrl?: string | null;
  devPresets?: DevPreset[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  config: AuthConfig | null;
  loginWithFeishu: () => void;
  loginDev: (name: string, role: UserRole) => Promise<void>;
  loginDevPreset: (key: string) => Promise<void>;
  completeFeishuLogin: (code: string) => Promise<void>;
  updateRole: (role: UserRole) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  isRequester: boolean;
  isExecutor: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const log = logger.child({ module: 'auth' });

function feishuRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // 会话过期（持有 token 时收到 401）：清用户态、提示并跳转登录页
  useEffect(() => {
    const onAuthExpired = () => {
      setUser(null);
      sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
      toast.error('登录已过期，请重新登录');
      navigate('/login', { replace: true });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, [navigate]);

  const refreshMe = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    const me = await api.get<AuthUser>('/auth/me');
    setUser(me);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const redirectUri = encodeURIComponent(feishuRedirectUri());
        const cfg = await api.get<AuthConfig>(`/auth/config?redirectUri=${redirectUri}`);
        setConfig(cfg);
        if (getToken()) {
          await refreshMe();
        } else if (!cfg.feishuEnabled && cfg.devLoginEnabled && cfg.devPresets?.some((preset) => preset.key === 'requester')) {
          // 本地部署默认进入需求方工作台；正式环境开启飞书后不会走这条路径。
          const result = await api.post<{ token: string; user: AuthUser }>('/auth/dev-login/preset/requester');
          setToken(result.token);
          setUser(result.user);
          log.info('本地免登录进入需求方工作台', { userId: result.user.id });
        }
      } catch (err) {
        log.error('初始化鉴权失败', err);
        setToken(null);
        setUser(null);
        // 兜底：初始化期 /auth/me 返回 401（会话已失效）时同样提示过期
        if (err instanceof ApiError && err.status === 401) {
          sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
          toast.error('登录已过期，请重新登录');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshMe]);

  const loginWithFeishu = useCallback(() => {
    if (!config?.authorizeUrl) {
      throw new Error('飞书登录未配置');
    }
    window.location.href = config.authorizeUrl;
  }, [config]);

  const completeFeishuLogin = useCallback(async (code: string) => {
    const result = await api.post<{ token: string; user: AuthUser }>('/auth/feishu/callback', {
      code,
      redirectUri: feishuRedirectUri(),
    });
    setToken(result.token);
    setUser(result.user);
    log.info('飞书登录成功', { userId: result.user.id });
  }, []);

  const loginDev = useCallback(async (name: string, role: UserRole) => {
    const result = await api.post<{ token: string; user: AuthUser }>('/auth/dev-login', { name, role });
    setToken(result.token);
    setUser(result.user);
    log.info('开发登录成功', { userId: result.user.id, role });
  }, []);

  const loginDevPreset = useCallback(async (key: string) => {
    const result = await api.post<{ token: string; user: AuthUser }>(`/auth/dev-login/preset/${key}`);
    setToken(result.token);
    setUser(result.user);
    log.info('开发预设登录成功', { userId: result.user.id, preset: key, role: result.user.role });
  }, []);

  const updateRole = useCallback(async (role: UserRole) => {
    const me = await api.patch<AuthUser>('/auth/me/role', { role });
    setUser(me);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      config,
      loginWithFeishu,
      loginDev,
      loginDevPreset,
      completeFeishuLogin,
      updateRole,
      logout,
      refreshMe,
      isRequester: !!user && user.role === 'requester',
      isExecutor: !!user && user.role === 'executor',
    }),
    [
      user,
      loading,
      config,
      loginWithFeishu,
      loginDev,
      loginDevPreset,
      completeFeishuLogin,
      updateRole,
      logout,
      refreshMe,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

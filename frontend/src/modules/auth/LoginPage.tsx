import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { SESSION_EXPIRED_KEY, useAuth, type UserRole } from '@shared/auth/AuthContext';
import { defaultExecutorOrgLabel } from '@shared/auth/executorOrgs';

export function LoginPage() {
  const { user, loading, config, loginWithFeishu, loginDev, loginDevPreset } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('演示用户');
  const [role, setRole] = useState<UserRole>('requester');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const executorLabel = defaultExecutorOrgLabel();
  // 会话过期横幅：读 sessionStorage 标记（一次性），兼容刷新与操作中过期两种场景
  const [sessionExpired] = useState(() => {
    const flag = sessionStorage.getItem(SESSION_EXPIRED_KEY) === '1';
    if (flag) sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    return flag;
  });

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  const afterLogin = (_nextRole: UserRole) => {
    navigate('/', { replace: true });
  };

  const onDevLogin = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await loginDev(name.trim(), role);
      afterLogin(role);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  const onPresetLogin = async (key: string) => {
    setPresetKey(key);
    setError(null);
    try {
      await loginDevPreset(key);
      afterLogin(key === 'requester' ? 'requester' : 'executor');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setPresetKey(null);
    }
  };

  const presets = config?.devPresets || [];

  return (
    <main className="page auth-page">
      <div className="auth-stage">
        <p className="brand">
          <img src="/brand-qinglan.svg" alt="清蓝" width={220} height={35} />
        </p>
        <h1>用结构化流程管理每一条需求</h1>
        <p className="lead">
          需求方绑定项目提交；{executorLabel}评定优先级并推进进度（执行方也可自提并自行验收）。
        </p>

        {sessionExpired && (
          <p className="notice auth-expired-notice" role="alert">
            登录已过期，请重新登录
          </p>
        )}

        {config?.feishuEnabled && (
          <div className="auth-block">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                try {
                  loginWithFeishu();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '无法跳转飞书');
                }
              }}
            >
              使用飞书账号登录
            </button>
          </div>
        )}

        {config?.devLoginEnabled && presets.length > 0 && (
          <div className="auth-block dev-presets">
            <h2>开发测试账号</h2>
            <p className="hint">一键进入固定身份，便于联调需求方 / {executorLabel}流程。</p>
            <div className="dev-preset-list">
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="btn-secondary"
                  disabled={presetKey === p.key}
                  onClick={() => void onPresetLogin(p.key)}
                >
                  {presetKey === p.key ? '登录中...' : p.label}
                </button>
              ))}
            </div>
            {presets.map((p) => (
              <p key={`${p.key}-hint`} className="hint">
                {p.label}：{p.hint}
              </p>
            ))}
          </div>
        )}

        {config?.devLoginEnabled && (
          <form className="auth-block dev-login" onSubmit={onDevLogin}>
            <h2>自定义开发登录</h2>
            <p className="hint">本地联调可用，不走飞书授权。</p>
            <label>
              昵称
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
            </label>
            <label>
              身份
              <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                <option value="requester">需求方</option>
                <option value="executor">{executorLabel}</option>
              </select>
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? '登录中...' : '进入系统'}
            </button>
          </form>
        )}

        {!config?.feishuEnabled && !config?.devLoginEnabled && !loading && (
          <p className="error-text">未配置可用登录方式，请设置飞书凭证或开启开发登录。</p>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </main>
  );
}

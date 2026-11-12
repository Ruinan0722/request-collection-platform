import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/auth/AuthContext';
import { getToken } from '@shared/api/client';

/** 同一授权码只兑换一次，StrictMode 重挂载共用同一个 Promise */
const exchangeByCode = new Map<string, Promise<void>>();

function homeForRole(role?: string | null) {
  return role === 'requester' ? '/submit' : '/';
}

export function AuthCallbackPage() {
  const [params] = useSearchParams();
  const { completeFeishuLogin, user } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 已登录则按身份进入对应首页
    if (getToken()) {
      navigate(homeForRole(user?.role), { replace: true });
      return;
    }

    const code = params.get('code');
    if (!code) {
      setError('缺少授权码 code，请返回重新登录');
      return;
    }

    let pending = exchangeByCode.get(code);
    if (!pending) {
      pending = completeFeishuLogin(code).finally(() => {
        // 保留短时间缓存，避免并发重复；成功后由跳转离开本页
      });
      exchangeByCode.set(code, pending);
    }

    void (async () => {
      try {
        await pending;
        if (cancelled) return;
        window.history.replaceState({}, '', '/auth/callback');
        // completeFeishuLogin 已写入 user；再读一次 local 角色不方便，先到 / 由 HomeEntry 分流
        navigate('/', { replace: true });
      } catch (err) {
        exchangeByCode.delete(code);
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '飞书登录失败');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params, completeFeishuLogin, navigate, user?.role]);

  return (
    <main className="page auth-page">
      <div className="auth-stage">
        <p className="brand">
          <img src="/brand-qinglan.svg" alt="清蓝" width={220} height={35} />
        </p>
        <h1>正在完成飞书授权</h1>
        {error ? (
          <div>
            <p className="error-text">{error}</p>
            <p className="lead">
              <a href="/login">返回重新登录</a>
            </p>
          </div>
        ) : (
          <p className="lead">请稍候，马上进入系统...</p>
        )}
      </div>
    </main>
  );
}

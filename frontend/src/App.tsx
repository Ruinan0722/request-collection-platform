import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { AuthCallbackPage } from '@modules/auth/AuthCallbackPage';
import { LoginPage } from '@modules/auth/LoginPage';
import { HomeDashboardPage } from '@modules/home/HomeDashboardPage';
import { RequesterDashboardPage } from '@modules/home/RequesterDashboardPage';
import { ProjectBoardPage } from '@modules/projects/ProjectBoardPage';
import { RequirementCreatePage } from '@modules/requirements/RequirementCreatePage';
import { RequirementDetailPage } from '@modules/requirements/RequirementDetailPage';
import { RequirementsListPage } from '@modules/requirements/RequirementsListPage';
import { useAuth } from '@shared/auth/AuthContext';
import { canCreateRequirement } from '@shared/auth/capabilities';
import { defaultExecutorOrgLabel } from '@shared/auth/executorOrgs';
import { ToastHost } from '@shared/toast';

function ProtectedLayout() {
  const { user, loading, logout, updateRole, isRequester } = useAuth();

  if (loading) {
    return (
      <main className="page">
        <p>加载中...</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const homePath = '/';
  const canSubmit = canCreateRequirement(user.role);
  const executorLabel = defaultExecutorOrgLabel();

  return (
    <div className="app-shell">
      <aside className="side-nav" aria-label="主导航">
        <div className="side-nav-top">
          <NavLink to={homePath} end className="nav-brand" aria-label="清蓝">
            <img src="/brand-qinglan.svg" alt="清蓝" width={148} height={24} />
          </NavLink>
          <nav className="side-nav-links">
            <NavLink to="/" end>
              {isRequester ? '我的需求' : '工作台'}
            </NavLink>
            {canSubmit && <NavLink to="/submit">提需求</NavLink>}
            <NavLink to="/requirements">需求列表</NavLink>
          </nav>
        </div>
        <div className="nav-user">
          <div className="nav-user-meta">
            <strong>{user.name}</strong>
            <em>
              {user.role === 'requester' && '需求方'}
              {user.role === 'executor' && executorLabel}
            </em>
            {user.departmentNames && user.departmentNames.length > 0 && (
              <em className="nav-dept">{user.departmentNames.join(' · ')}</em>
            )}
          </div>
          {!user.roleLocked && user.roleSource !== 'feishu' ? (
            <select
              aria-label="切换身份"
              value={user.role}
              onChange={(e) => void updateRole(e.target.value as 'requester' | 'executor')}
            >
              <option value="requester">需求方</option>
              <option value="executor">{executorLabel}</option>
            </select>
          ) : null}
          <button type="button" className="linkish" onClick={logout}>
            退出
          </button>
        </div>
      </aside>
      <div className="app-main">
        <Outlet />
      </div>
    </div>
  );
}

/** 首页入口：需求方进「我的需求」，执行方进工作台 */
function HomeEntry() {
  const { isRequester } = useAuth();
  if (isRequester) {
    return <RequesterDashboardPage />;
  }
  return <HomeDashboardPage />;
}

/** 项目看板仅执行方可访问 */
function ExecutorProjectBoard() {
  const { isRequester, loading } = useAuth();
  if (loading) {
    return (
      <main className="page">
        <p>加载中...</p>
      </main>
    );
  }
  if (isRequester) {
    return <Navigate to="/requirements" replace />;
  }
  return <ProjectBoardPage />;
}

export function App() {
  return (
    <>
      <ToastHost />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<HomeEntry />} />
          <Route path="/projects/:projectId" element={<ExecutorProjectBoard />} />
          <Route path="/submit" element={<RequirementCreatePage />} />
          <Route path="/requirements" element={<RequirementsListPage />} />
          <Route path="/requirements/new" element={<Navigate to="/submit" replace />} />
          <Route path="/requirements/:id" element={<RequirementDetailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

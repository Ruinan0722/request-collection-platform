import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { api } from '@shared/api/client';
import { useAuth } from '@shared/auth/AuthContext';
import { detailLinkState, rememberReturnTo } from '@shared/nav/returnTo';
import type { Project, Requirement } from '@shared/types/domain';
import { PRIORITY_LABEL } from '@shared/types/domain';
import { logger } from '@shared/logger/index';

const log = logger.child({ module: 'project-board' });

interface BoardData {
  project: Project;
  columns: Array<{ status: string; label: string; items: Requirement[] }>;
}

export function ProjectBoardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const returnPath = `${location.pathname}${location.search}`;
  const { isRequester, isExecutor } = useAuth();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rememberReturnTo(returnPath);
  }, [returnPath]);

  useEffect(() => {
    if (!projectId || !isExecutor) return;
    void (async () => {
      try {
        const data = await api.get<BoardData>(`/projects/${projectId}/board`);
        setBoard(data);
      } catch (err) {
        log.error('加载看板失败', err);
        setError(err instanceof Error ? err.message : '加载失败');
      }
    })();
  }, [projectId, isExecutor]);

  if (isRequester) {
    return <Navigate to="/requirements" replace />;
  }

  if (error) {
    return (
      <main className="page">
        <p className="error-text">{error}</p>
        <Link to="/">返回工作台</Link>
      </main>
    );
  }

  if (!board) {
    return (
      <main className="page">
        <p>看板加载中...</p>
      </main>
    );
  }

  return (
    <main className="page board-page page-fill">
      <header className="section-head">
        <div>
          <p className="crumb">
            <Link to="/">工作台</Link> / {board.project.name}
          </p>
          <h1>{board.project.name} · 看板</h1>
          <p className="lead">{board.project.description || '按状态查看本项目需求'}</p>
        </div>
      </header>

      <div className="kanban show-scrollbar-x">
        {board.columns.map((col) => (
          <section key={col.status} className="kanban-col">
            <h2>
              {col.label}
              <span>{col.items.length}</span>
            </h2>
            <ul className="show-scrollbar-y">
              {col.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/requirements/${item.id}`}
                    state={detailLinkState(returnPath)}
                    className={`kanban-card prio-card prio-${item.priority || 'unset'}`}
                  >
                    <strong>{item.title}</strong>
                    <em>{PRIORITY_LABEL[item.priority]}</em>
                    <small>{item.requesterName || '未知提需人'}</small>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

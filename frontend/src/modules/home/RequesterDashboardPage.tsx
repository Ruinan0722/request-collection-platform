import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '@shared/api/client';
import { detailLinkState, rememberReturnTo } from '@shared/nav/returnTo';
import type { Requirement } from '@shared/types/domain';
import { formatDateTimeShort } from '@shared/utils/datetime';
import { logger } from '@shared/logger/index';

const log = logger.child({ module: 'requester-dashboard' });
const RECENT_LIMIT = 5;

interface MyStats {
  total: number;
  pendingAccept: number;
  implementing: number;
  done: number;
}

function countStats(items: Requirement[]): MyStats {
  return items.reduce<MyStats>(
    (acc, item) => {
      acc.total += 1;
      if (item.status === 'pending_accept') acc.pendingAccept += 1;
      if (item.status === 'implementing') acc.implementing += 1;
      if (item.status === 'done') acc.done += 1;
      return acc;
    },
    { total: 0, pendingAccept: 0, implementing: 0, done: 0 },
  );
}

function stageCopy(item: Requirement) {
  switch (item.status) {
    case 'evaluating':
    case 'backlog':
      return { label: '接收方评估中', next: '确认需求范围与优先级', tone: 'evaluating' };
    case 'waiting_impl':
    case 'todo':
      return { label: '已进入排期', next: '等待开始实现', tone: 'waiting' };
    case 'implementing':
    case 'doing':
      return { label: '正在实现', next: '接收方完成开发后通知你', tone: 'doing' };
    case 'pending_accept':
      return { label: '等你验收', next: '打开详情确认是否达到预期', tone: 'accept' };
    case 'done':
      return { label: '已完成', next: '这条需求已经可以使用', tone: 'done' };
    case 'wont_impl':
      return { label: '暂不实现', next: '打开详情查看原因或补充信息', tone: 'wont' };
    default:
      return { label: item.statusLabel || '处理中', next: '接收方会更新下一步', tone: 'evaluating' };
  }
}

function targetCopy(item: Requirement) {
  if (item.status === 'done') return '已完成';
  if (item.dueDate) return `业务节点 ${item.dueDate.slice(0, 10)}`;
  return '接收方排期后更新';
}

/** 需求方工作台：我的需求概览 + 最近需求 + 快捷入口 */
export function RequesterDashboardPage() {
  const location = useLocation();
  const returnPath = `${location.pathname}${location.search}`;
  const [items, setItems] = useState<Requirement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    rememberReturnTo(returnPath);
  }, [returnPath]);

  const load = async () => {
    try {
      const list = await api.get<Requirement[]>('/requirements?mine=requester');
      setItems(list);
      setError(null);
    } catch (err) {
      log.error('加载我的需求失败', err);
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => countStats(items), [items]);
  const recent = useMemo(
    () =>
      [...items]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, RECENT_LIMIT),
    [items],
  );

  if (error && items.length === 0) {
    return (
      <main className="page">
        <p className="error-text">{error}</p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="page">
        <p className="hint">正在读取你的需求...</p>
      </main>
    );
  }

  const activeCount = items.filter((item) => !['done', 'wont_impl'].includes(item.status)).length;

  return (
    <main className="page home-page requester-home-page">
      <header className="requester-welcome">
        <div>
          <p className="eyebrow">需求工作台</p>
          <h1>把想法交给我们，进度一目了然</h1>
          <p className="lead">按模板提需求，提交后只需关注当前节点、下一步和目标日期。</p>
        </div>
        <div className="section-head-actions">
          <Link className="btn-primary" to="/submit">
            + 提一条需求
          </Link>
          <Link className="btn-secondary" to="/requirements?view=board">
            看我的进度
          </Link>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <section className="requester-kpi-row" aria-label="我的需求总览">
        <article className="requester-kpi requester-kpi-main">
          <p className="home-stat-label">我提出的需求</p>
          <p className="home-total-value">{stats.total}</p>
          <p className="home-stat-hint">其中 {activeCount} 条正在推进</p>
        </article>
        <Link className="requester-kpi" to="/requirements?status=pending_accept">
          <p className="home-stat-label">待我验收</p>
          <p className="home-stage-value">{stats.pendingAccept}</p>
          <p className="home-stat-hint">完成后需要你确认</p>
        </Link>
        <Link className="requester-kpi" to="/requirements?status=implementing">
          <p className="home-stat-label">正在实现</p>
          <p className="home-stage-value">{stats.implementing}</p>
          <p className="home-stat-hint">接收方正在处理</p>
        </Link>
        <Link className="requester-kpi" to="/requirements?status=done">
          <p className="home-stat-label">已完成</p>
          <p className="home-stage-value">{stats.done}</p>
          <p className="home-stat-hint">已经可以使用</p>
        </Link>
      </section>

      <section className="requester-flow" aria-label="需求处理流程">
        <div className="requester-flow-heading">
          <div>
            <p className="eyebrow">你只需要做三件事</p>
            <h2>提清楚 · 看进度 · 做验收</h2>
          </div>
          <p>接收方会负责评估、排期和实现，并在关键节点更新状态。</p>
        </div>
        <ol>
          <li><span>1</span><strong>填模板</strong><small>说清问题和希望的结果</small></li>
          <li><span>2</span><strong>看进度</strong><small>列表或看板查看当前节点</small></li>
          <li><span>3</span><strong>做验收</strong><small>完成后确认是否达到预期</small></li>
        </ol>
      </section>

      <section className="home-dept-section" aria-label="最近需求">
          <header className="section-head requester-section-head">
            <div>
            <h2>最近需求</h2>
            <p className="lead">每张卡片只展示你最关心的进度信息。</p>
            </div>
            <Link className="linkish" to="/requirements">查看全部 →</Link>
          </header>

        {recent.length === 0 ? (
          <div className="requester-empty-state">
            <strong>还没有需求</strong>
            <p>用模板填第一条，接收方会在这里同步进度。</p>
            <Link className="btn-primary" to="/submit">提第一条需求</Link>
          </div>
        ) : (
          <ul className="requester-recent-grid">
            {recent.map((item) => (
              <li key={item.id}>
                <Link to={`/requirements/${item.id}`} state={detailLinkState(returnPath)}>
                  <span className="requester-recent-top">
                    <span className="my-recent-title" title={item.afterImpl || undefined}>{item.title}</span>
                    <span className={`status-badge status-${item.status}`}>{stageCopy(item).label}</span>
                  </span>
                  <span className="requester-recent-progress"><i className={`requester-progress-dot is-${stageCopy(item).tone}`} />{stageCopy(item).next}</span>
                  <span className="requester-recent-meta"><span>{targetCopy(item)}</span><time dateTime={item.createdAt || undefined}>提交于 {formatDateTimeShort(item.createdAt)}</time></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

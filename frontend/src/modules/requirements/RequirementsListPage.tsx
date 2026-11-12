import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@shared/api/client';
import { useAuth } from '@shared/auth/AuthContext';
import { DateRangeField } from '@shared/components/DateRangeField';
import { detailLinkState, rememberReturnTo } from '@shared/nav/returnTo';
import {
  mergeRequirementsListPrefs,
  readRequirementsListPrefs,
  writeRequirementsListPrefs,
  type RequirementsListPrefs,
} from '@shared/nav/requirementsListPrefs';
import type { Priority, Project, Requirement } from '@shared/types/domain';
import { PRIORITY_LABEL, PROGRESS_ORDER, STATUS_LABEL } from '@shared/types/domain';
import { getRequirementListFields } from '@shared/utils/requirementListFields';
import { formatDateTimeShort } from '@shared/utils/datetime';
import { sortByPriority } from '@shared/utils/priority';
import { logger } from '@shared/logger/index';
import { toast } from '@shared/toast';

const log = logger.child({ module: 'requirements-list' });
const PAGE_SIZE = 10;

interface BoardPayload {
  columns: Array<{ status: string; label: string; items: Requirement[] }>;
  total: number;
}

const REQUESTER_STAGES = [
  { code: 'evaluating', label: '接收评估' },
  { code: 'waiting_impl', label: '已排期' },
  { code: 'implementing', label: '正在实现' },
  { code: 'pending_accept', label: '等你验收' },
  { code: 'done', label: '已完成' },
] as const;

function requesterStage(item: Requirement) {
  if (item.status === 'backlog') return REQUESTER_STAGES[0];
  if (item.status === 'todo') return REQUESTER_STAGES[1];
  if (item.status === 'doing') return REQUESTER_STAGES[2];
  return REQUESTER_STAGES.find((stage) => stage.code === item.status) || { code: item.status, label: item.statusLabel || '处理中' };
}

function requesterNextStep(item: Requirement) {
  switch (item.status) {
    case 'evaluating':
    case 'backlog':
      return '接收方确认范围和优先级';
    case 'waiting_impl':
    case 'todo':
      return '等待进入实现';
    case 'implementing':
    case 'doing':
      return '接收方完成后通知你';
    case 'pending_accept':
      return '打开详情，确认是否达到预期';
    case 'done':
      return '这条需求已经可以使用';
    case 'wont_impl':
      return '打开详情查看原因';
    default:
      return '接收方会更新下一步';
  }
}

function requesterTarget(item: Requirement) {
  if (item.status === 'done') return { label: '已完成', hint: '已上线/可使用' };
  if (!item.dueDate) return { label: '待排期', hint: '接收方确认后更新' };
  const date = new Date(`${item.dueDate.slice(0, 10)}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((date.getTime() - today.getTime()) / 86400000);
  const countdown = days < 0 ? '已超过节点' : days === 0 ? '就是今天' : `还有 ${days} 天`;
  return { label: item.dueDate.slice(0, 10), hint: countdown };
}

function RequesterRequirementCard({ item, compact = false }: { item: Requirement; compact?: boolean }) {
  const stage = requesterStage(item);
  const target = requesterTarget(item);
  const stageIndex = Math.max(0, REQUESTER_STAGES.findIndex((entry) => entry.code === stage.code));
  return (
    <Link className="requester-requirement-card" to={`/requirements/${item.id}`} state={detailLinkState('/requirements?view=board')}>
      {compact ? <div className="requester-card-title-row"><h3>{item.title}</h3><span className="requester-card-arrow" aria-hidden="true">↗</span></div> : <><div className="requester-card-top"><span className={`status-badge status-${item.status}`}>{stage.label}</span><span className="requester-card-arrow">↗</span></div><h3 title={item.title}>{item.title}</h3></>}
      {!compact && <p className="requester-card-result">{item.afterImpl || '已提交，等待接收方补充处理信息。'}</p>}
      {!compact && <div className="requester-mini-timeline" aria-label={`当前进度：${stage.label}`}>
        {REQUESTER_STAGES.map((entry, index) => <span key={entry.code} className={index < stageIndex ? 'is-done' : index === stageIndex ? 'is-current' : ''} title={entry.label} />)}
      </div>}
      <div className="requester-card-details">
        <div><small>下一步</small><strong>{requesterNextStep(item)}</strong></div>
        <div><small>{item.dueDate ? '业务节点' : '预计上线'}</small><strong>{target.label}</strong><em>{target.hint}</em></div>
      </div>
    </Link>
  );
}

function RequesterFriendlyView({
  items,
  view,
  status,
  pendingAcceptCount,
  error,
  updateFilter,
}: {
  items: Requirement[];
  view: 'list' | 'board';
  status: string;
  pendingAcceptCount: number;
  error: string | null;
  updateFilter: (key: string, value: string) => void;
}) {
  const visibleItems = status ? items.filter((item) => item.status === status || (status === 'evaluating' && item.status === 'backlog')) : items;
  const boardColumns = REQUESTER_STAGES.map((stage) => ({ ...stage, items: visibleItems.filter((item) => requesterStage(item).code === stage.code) }));
  return (
    <main className="page requester-requirements-page">
      <header className="requester-list-welcome">
        <div><p className="eyebrow">需求进度</p><h1>每一条需求，现在到哪了？</h1><p className="lead">看当前节点、下一步和目标日期；不需要理解内部的优先级和项目字段。</p></div>
        <div className="section-head-actions"><Link className="btn-primary" to="/submit">+ 提一条需求</Link><div className="view-mode-tabs requester-view-tabs" role="tablist" aria-label="视图切换"><button type="button" className={view === 'board' ? 'is-active' : ''} onClick={() => updateFilter('view', '')}>看板</button><button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => updateFilter('view', 'list')}>列表</button></div></div>
      </header>
      <section className="requester-list-summary" aria-label="需求摘要"><div><strong>{items.length}</strong><span>全部需求</span></div><div><strong>{items.filter((item) => !['done', 'wont_impl'].includes(item.status)).length}</strong><span>正在推进</span></div><div><strong>{pendingAcceptCount}</strong><span>待我验收</span></div><div><strong>{items.filter((item) => item.status === 'done').length}</strong><span>已完成</span></div></section>
      <div className="requester-list-tools"><span>共 {visibleItems.length} 条{status ? ' · 已按状态筛选' : ''}</span><label>快速筛选<select aria-label="快速筛选状态" value={status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">全部状态</option>{REQUESTER_STAGES.map((stage) => <option key={stage.code} value={stage.code}>{stage.label}</option>)}<option value="wont_impl">暂不实现</option></select></label>{status && <button type="button" className="linkish" onClick={() => updateFilter('status', '')}>清除筛选</button>}</div>
      {error && <p className="error-text">{error}</p>}
      {visibleItems.length === 0 ? <div className="requester-empty-state requester-list-empty"><strong>还没有需求</strong><p>提第一条需求后，接收方的每一步都会在这里显示。</p><Link className="btn-primary" to="/submit">按模板提需求</Link></div> : view === 'board' ? <div className="requester-board" aria-label="需求进度看板">{boardColumns.map((column) => <section key={column.code} className="requester-board-column"><header><div><span className="requester-board-kicker">{String(boardColumns.indexOf(column) + 1).padStart(2, '0')}</span><h2>{column.label}</h2></div><strong>{column.items.length}</strong></header><div className="requester-board-items">{column.items.length === 0 ? <p className="requester-board-empty">暂无需求</p> : column.items.map((item) => <RequesterRequirementCard key={item.id} item={item} compact />)}</div></section>)}</div> : <div className="requester-card-grid">{visibleItems.map((item) => <RequesterRequirementCard key={item.id} item={item} />)}</div>}
    </main>
  );
}

function prefsFromSearchParams(
  next: URLSearchParams,
  isRequester: boolean,
): RequirementsListPrefs {
  return {
    view: isRequester
      ? next.get('view') === 'list' ? 'list' : 'board'
      : next.get('view') === 'board' ? 'board' : 'list',
    projectId: next.get('projectId') || '',
    status: next.get('status') || '',
    priority: next.get('priority') || '',
    mine: isRequester ? '' : next.get('mine') || '',
    claimed: '',
    createdFrom: next.get('createdFrom') || '',
    createdTo: next.get('createdTo') || '',
    dueFrom: next.get('dueFrom') || '',
    dueTo: next.get('dueTo') || '',
  };
}

export function RequirementsListPage() {
  const { user, isExecutor, isRequester } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Requirement[]>([]);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prefsUserIdRef = useRef<string | null>(null);

  const returnPath = `${location.pathname}${location.search}`;

  useEffect(() => {
    rememberReturnTo(returnPath);
  }, [returnPath]);

  // 按用户恢复筛选；切换账号时丢弃上一账号留在 URL 里的条件
  useLayoutEffect(() => {
    if (!user?.id) return;
    const switched = !!prefsUserIdRef.current && prefsUserIdRef.current !== user.id;
    prefsUserIdRef.current = user.id;
    const prefs = readRequirementsListPrefs(user.id);

    if (switched) {
      const next = new URLSearchParams();
      if (!isRequester && prefs.view === 'board') next.set('view', 'board');
      if (prefs.projectId) next.set('projectId', prefs.projectId);
      if (prefs.status) next.set('status', prefs.status);
      if (prefs.priority) next.set('priority', prefs.priority);
      if (!isRequester && prefs.mine) next.set('mine', prefs.mine);
      if (prefs.createdFrom) next.set('createdFrom', prefs.createdFrom);
      if (prefs.createdTo) next.set('createdTo', prefs.createdTo);
      if (prefs.dueFrom) next.set('dueFrom', prefs.dueFrom);
      if (prefs.dueTo) next.set('dueTo', prefs.dueTo);
      setParams(next, { replace: true });
      return;
    }

    const merged = mergeRequirementsListPrefs(params, prefs);
    if (merged) {
      setParams(merged, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isRequester]);

  const projectId = params.get('projectId') || '';
  const status = params.get('status') || '';
  const priority = params.get('priority') || '';
  // 需求方固定只看自己的；执行方可筛选范围（含「我提的」自建需求）
  // 统一用 mine=requester 表示「我提的」，避免旧 mine=mine（我负责的）语义混淆
  const mine = isRequester ? 'requester' : params.get('mine') || '';
  const view = isRequester
    ? params.get('view') === 'list' ? 'list' : 'board'
    : params.get('view') === 'board' ? 'board' : 'list';
  const createdFrom = params.get('createdFrom') || '';
  const createdTo = params.get('createdTo') || '';
  const dueFrom = params.get('dueFrom') || '';
  const dueTo = params.get('dueTo') || '';
  const pageRaw = Number(params.get('page') || '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const listQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (status) q.set('status', status);
    if (priority) q.set('priority', priority);
    if (mine) q.set('mine', mine);
    if (createdFrom) q.set('createdFrom', createdFrom);
    if (createdTo) q.set('createdTo', createdTo);
    if (dueFrom) q.set('dueFrom', dueFrom);
    if (dueTo) q.set('dueTo', dueTo);
    const s = q.toString();
    return s ? `?${s}` : '';
  }, [projectId, status, priority, mine, createdFrom, createdTo, dueFrom, dueTo]);

  const boardQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    // 与列表一致透传 mine，避免切看板后筛选丢失
    if (mine) q.set('mine', mine);
    if (createdFrom) q.set('createdFrom', createdFrom);
    if (createdTo) q.set('createdTo', createdTo);
    if (dueFrom) q.set('dueFrom', dueFrom);
    if (dueTo) q.set('dueTo', dueTo);
    const s = q.toString();
    return s ? `?${s}` : '';
  }, [projectId, mine, createdFrom, createdTo, dueFrom, dueTo]);

  const reload = async () => {
    try {
      const projectList = await api.get<Project[]>('/projects');
      setProjects(projectList);
      if (view === 'board') {
        const data = await api.get<BoardPayload>(`/requirements/board${boardQuery}`);
        setBoard({
          ...data,
          columns: data.columns.map((c) => ({ ...c, items: sortByPriority(c.items) })),
        });
        setItems(sortByPriority(data.columns.flatMap((c) => c.items)));
      } else {
        const list = await api.get<Requirement[]>(`/requirements${listQuery}`);
        setItems(sortByPriority(list));
        setBoard(null);
      }
      setError(null);
    } catch (err) {
      log.error('加载需求列表失败', err);
      setError(err instanceof Error ? err.message : '加载失败');
    }
  };

  useEffect(() => {
    void reload();
  }, [listQuery, boardQuery, view]);

  const updateFilter = (key: string, value: string) => {
    updateFilters({ [key]: value });
  };

  const updateFilters = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    let touchPaging = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page' && key !== 'view') touchPaging = true;
    }
    if (touchPaging) next.delete('page');
    writeRequirementsListPrefs(prefsFromSearchParams(next, isRequester), user?.id);
    setParams(next);
  };

  const resetFilters = () => {
    const next = new URLSearchParams();
    if (isRequester) {
      if (view === 'list') next.set('view', 'list');
    } else if (view === 'board') {
      next.set('view', 'board');
    }
    writeRequirementsListPrefs(prefsFromSearchParams(next, isRequester), user?.id);
    setParams(next);
  };

  const hasActiveFilters = Boolean(
    projectId ||
      status ||
      priority ||
      (!isRequester && mine) ||
      createdFrom ||
      createdTo ||
      dueFrom ||
      dueTo,
  );

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, currentPage]);

  const goPage = (nextPage: number) => {
    const clamped = Math.min(Math.max(1, nextPage), totalPages);
    updateFilter('page', clamped <= 1 ? '' : String(clamped));
  };

  const pendingAcceptCount = useMemo(
    () => items.filter((i) => i.status === 'pending_accept').length,
    [items],
  );

  const visibleBoardColumns = useMemo(() => {
    const cols = board?.columns || [];
    return cols
      .filter((col) => !status || col.status === status)
      .map((col) => ({
        ...col,
        items: priority
          ? col.items.filter((item) => (item.priority || 'unset') === priority)
          : col.items,
      }));
  }, [board, status, priority]);

  // —— 看板拖拽改状态（仅执行方） ——
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  if (isRequester) {
    return (
      <RequesterFriendlyView
        items={items}
        view={view}
        status={status}
        pendingAcceptCount={pendingAcceptCount}
        error={error}
        updateFilter={updateFilter}
      />
    );
  }

  const onDragStart = (itemId: string) => {
    setDragItemId(itemId);
  };
  const onDragEnd = () => {
    setDragItemId(null);
    setDragOverCol(null);
  };
  const onDropToColumn = async (colStatus: string) => {
    const itemId = dragItemId;
    setDragItemId(null);
    setDragOverCol(null);
    if (!itemId) return;
    const item = items.find((it) => it.id === itemId);
    if (!item || item.status === colStatus) return;
    try {
      const updated = await api.patch<Requirement>(`/requirements/${itemId}`, { status: colStatus });
      toast.success(`「${item.title}」已移至${updated.statusLabel || STATUS_LABEL[updated.status]}`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '状态更新失败');
    }
  };

  return (
    <main className="page board-page page-fill">
      <header className="section-head req-list-head">
        <div>
          <h1>需求列表</h1>
          {isRequester && (
            <p className="lead">
              当前账号：{user?.name || '需求方'}
              {pendingAcceptCount > 0
                ? ` · 有 ${pendingAcceptCount} 条待验收`
                : ''}
            </p>
          )}
        </div>
        <div className="section-head-actions">
          {isRequester && pendingAcceptCount > 0 && status !== 'pending_accept' && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => updateFilter('status', 'pending_accept')}
            >
              只看待验收
            </button>
          )}
          <div className="view-mode-tabs" role="tablist" aria-label="视图切换">
            <button
              type="button"
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => updateFilter('view', '')}
            >
              列表
            </button>
            <button
              type="button"
              className={view === 'board' ? 'is-active' : ''}
              onClick={() => updateFilter('view', 'board')}
            >
              看板
            </button>
          </div>
        </div>
      </header>

      <section className="filters req-filters" aria-label="需求筛选">
        <label>
          项目
          <select value={projectId} onChange={(e) => updateFilter('projectId', e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={status} onChange={(e) => updateFilter('status', e.target.value)}>
            <option value="">全部状态</option>
            {PROGRESS_ORDER.map((node) => (
              <option key={node.code} value={node.code}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          优先级
          <select value={priority} onChange={(e) => updateFilter('priority', e.target.value)}>
            <option value="">全部优先级</option>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <DateRangeField
          label="创建时间"
          precision="minute"
          placeholder="按创建时间筛选（可到时分）"
          value={{ from: createdFrom, to: createdTo }}
          onChange={(range) =>
            updateFilters({
              createdFrom: range.from,
              createdTo: range.to,
            })
          }
        />
        <DateRangeField
          label="业务节点"
          value={{ from: dueFrom, to: dueTo }}
          onChange={(range) =>
            updateFilters({
              dueFrom: range.from,
              dueTo: range.to,
            })
          }
        />
        {isExecutor && (
          <label>
            范围
            <select value={mine} onChange={(e) => updateFilter('mine', e.target.value)}>
              <option value="">全部</option>
              <option value="requester">我提的</option>
              <option value="assignee">我负责的</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className="btn-secondary req-filters-reset"
          disabled={!hasActiveFilters}
          onClick={resetFilters}
        >
          重置
        </button>
      </section>

      {error && <p className="error-text">{error}</p>}

      {view === 'board' ? (
        <div className="kanban show-scrollbar-x" aria-label="需求进度看板">
          {isExecutor && (
            <p className="hint kanban-drag-hint">执行方可将需求卡片拖拽到目标列快速改状态。</p>
          )}
          {visibleBoardColumns.map((col) => (
            <section
              key={col.status}
              className={`kanban-col${dragOverCol === col.status ? ' is-drag-over' : ''}`}
              onDragOver={(e) => {
                if (!isExecutor || !dragItemId) return;
                e.preventDefault();
                setDragOverCol(col.status);
              }}
              onDragLeave={() => setDragOverCol((prev) => (prev === col.status ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                void onDropToColumn(col.status);
              }}
            >
              <h2>
                {col.label}
                <span>{col.items.length}</span>
              </h2>
              <ul className="show-scrollbar-y">
                {col.items.length === 0 && <li className="hint is-empty">暂无</li>}
                {col.items.map((item) => {
                  const fields = getRequirementListFields(item);
                  return (
                    <li
                      key={item.id}
                      draggable={isExecutor}
                      onDragStart={() => onDragStart(item.id)}
                      onDragEnd={onDragEnd}
                    >
                      <Link
                        to={`/requirements/${item.id}`}
                        state={detailLinkState(returnPath)}
                        className={`kanban-card prio-card prio-${item.priority || 'unset'}${
                          dragItemId === item.id ? ' is-dragging' : ''
                        }`}
                      >
                        <strong>{item.title}</strong>
                        <em>{PRIORITY_LABEL[item.priority]}</em>
                        <small>
                          {item.projectName || '未命名项目'} · 节点 {fields.milestone}
                        </small>
                        <small>创建 {formatDateTimeShort(item.createdAt)}</small>
                        <small className="kanban-card-impact">
                          {fields.impact} · {fields.frequency} · {fields.reach}
                        </small>
                        {fields.afterImpl !== '-' && (
                          <small className="kanban-card-after">{fields.afterImpl}</small>
                        )}
                        {item.assigneeName && <small>{item.assigneeName}</small>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="list-panel">
          {items.length === 0 ? (
            <div className="table-wrap list-table-scroll list-empty-wrap">
              <p className="hint list-empty">暂无需求</p>
            </div>
          ) : (
            <div className="table-wrap list-table-scroll">
              <table className="data-table data-table-requirements">
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>状态</th>
                    <th>评定优先级</th>
                    <th>期望等级</th>
                    <th>业务节点</th>
                    <th>项目</th>
                    <th>创建时间</th>
                    <th>需求方</th>
                    <th>处理方</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => {
                    const fields = getRequirementListFields(item);
                    return (
                      <tr
                        key={item.id}
                        className="data-table-row-link"
                        tabIndex={0}
                        onClick={() =>
                          navigate(`/requirements/${item.id}`, {
                            state: detailLinkState(returnPath),
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            navigate(`/requirements/${item.id}`, {
                              state: detailLinkState(returnPath),
                            });
                          }
                        }}
                      >
                        <td>
                          <span className="row-title" title={item.afterImpl || undefined}>
                            {item.title}
                          </span>
                        </td>
                        <td>
                          <span className={`status-badge status-${item.status}`}>
                            {item.statusLabel || STATUS_LABEL[item.status]}
                          </span>
                        </td>
                        <td>
                          <span className={`prio-tag prio-${item.priority || 'unset'}`}>
                            {PRIORITY_LABEL[item.priority]}
                          </span>
                        </td>
                        <td>
                          <span className={`prio-tag prio-${fields.expectedLevel}`}>
                            {fields.expectedLevelLabel}
                          </span>
                        </td>
                        <td>{fields.milestone}</td>
                        <td>
                          {isExecutor ? (
                            <Link
                              to={`/projects/${item.projectId}`}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {item.projectName || item.projectId}
                            </Link>
                          ) : (
                            item.projectName || item.projectId
                          )}
                        </td>
                        <td>
                          <time dateTime={item.createdAt || undefined}>
                            {formatDateTimeShort(item.createdAt)}
                          </time>
                        </td>
                        <td>{item.requesterName || '-'}</td>
                        <td>{item.assigneeName || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="list-pager" aria-label="列表分页">
            <span className="list-pager-meta">
              共 {items.length} 条 · 每页 {PAGE_SIZE} 条 · 第 {currentPage}/{totalPages} 页
            </span>
            <div className="list-pager-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={currentPage <= 1}
                onClick={() => goPage(currentPage - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={currentPage >= totalPages}
                onClick={() => goPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

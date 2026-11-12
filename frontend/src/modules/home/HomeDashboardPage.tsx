import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '@shared/api/client';
import { detailLinkState, rememberReturnTo } from '@shared/nav/returnTo';
import { logger } from '@shared/logger/index';
import { toast } from '@shared/toast';

const log = logger.child({ module: 'home-dashboard' });

interface StageStat {
  code: string;
  label: string;
  count: number;
}

interface DepartmentStat {
  name: string;
  count: number;
  submitted?: number;
  solved?: number;
  ratio: number;
}

interface WeeklyDepartmentStat {
  name: string;
  submitted: number;
  solved: number;
}

interface WeeklyStats {
  from: string;
  to: string;
  departments: WeeklyDepartmentStat[];
  submittedTotal: number;
  solvedTotal: number;
}

interface ProjectCard {
  id: string;
  name: string;
  description?: string | null;
  requirementCount: number;
  counts: { todo: number; doing: number; done: number; wont: number };
  preview: Array<{ id: string; title: string; status: string; statusLabel?: string | null }>;
}

interface DashboardData {
  total: number;
  stages: StageStat[];
  departments: DepartmentStat[];
  weekly?: WeeklyStats;
  projects: ProjectCard[];
}

export function HomeDashboardPage() {
  const location = useLocation();
  const returnPath = `${location.pathname}${location.search}`;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    rememberReturnTo(returnPath);
  }, [returnPath]);

  const load = async () => {
    try {
      const payload = await api.get<DashboardData>('/requirements/dashboard');
      setData(payload);
      setError(null);
    } catch (err) {
      log.error('加载工作台失败', err);
      setError(err instanceof Error ? err.message : '加载失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const maxDeptCount = useMemo(() => {
    if (!data?.departments.length) return 1;
    return Math.max(
      ...data.departments.map((d) => d.submitted ?? d.count),
      1,
    );
  }, [data]);

  const onCreateProject = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/projects', { name, description });
      setName('');
      setDescription('');
      await load();
      toast.success(`项目「${name}」已创建`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setCreating(false);
    }
  };

  const onExportWeekly = async () => {
    if (!data?.weekly) return;
    setExporting(true);
    try {
      const q = new URLSearchParams({
        fromDay: data.weekly.from,
        toDay: data.weekly.to,
      });
      await api.download(
        `/requirements/stats/departments/weekly/export?${q.toString()}`,
        `部门需求周报_${data.weekly.from}_至_${data.weekly.to}.pdf`,
      );
      toast.success('部门需求周报已开始下载');
    } catch (err) {
      log.error('导出部门周统计失败', err);
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  if (error && !data) {
    return (
      <main className="page">
        <p className="error-text">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page">
        <p>工作台加载中...</p>
      </main>
    );
  }

  const weekly = data.weekly;

  return (
    <main className="page home-page">
      <header className="section-head">
        <div>
          <h1>工作台</h1>
          <p className="lead">总览需求规模与阶段分布，并按部门统计提需与解决情况。</p>
        </div>
        <Link className="btn-secondary" to="/requirements">
          全部需求
        </Link>
      </header>

      {error && <p className="error-text">{error}</p>}

      <section className="home-overview" aria-label="需求总览">
        <article className="home-total-panel">
          <p className="home-stat-label">需求总数</p>
          <p className="home-total-value">{data.total}</p>
          <p className="home-stat-hint">当前可见范围内的全部需求</p>
        </article>
        <div className="home-stage-grid" role="list">
          {data.stages.map((stage) => (
            <Link
              key={stage.code}
              className={`home-stage-card is-${stage.code}`}
              role="listitem"
              to={`/requirements?status=${encodeURIComponent(stage.code)}`}
              title={`查看${stage.label}需求`}
            >
              <p className="home-stat-label">{stage.label}</p>
              <p className="home-stage-value">{stage.count}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="home-dept-section" aria-label="部门提需分布">
        <header className="section-head">
          <div>
            <h2>各部门提需</h2>
            <p className="lead">按提需部门统计累计提出数与已解决数（已实现等待验收 / 已验收完成）。</p>
          </div>
        </header>

        {data.departments.length === 0 ? (
          <p className="hint">暂无需求数据</p>
        ) : (
          <div className="home-dept-chart" role="img" aria-label="各部门提需横向条形图">
            {data.departments.map((dept, index) => {
              const submitted = dept.submitted ?? dept.count;
              const solved = dept.solved ?? 0;
              const width = Math.max(6, Math.round((submitted / maxDeptCount) * 100));
              return (
                <div
                  key={dept.name}
                  className="home-dept-row"
                  style={{ animationDelay: `${index * 40}ms` }}
                >
                  <div className="home-dept-meta">
                    <strong title={dept.name}>{dept.name}</strong>
                    <span>
                      提出 {submitted} · 已解决 {solved}
                      {data.total > 0 ? ` · ${Math.round(dept.ratio * 100)}%` : ''}
                    </span>
                  </div>
                  <div className="home-dept-track" aria-hidden="true">
                    <div className="home-dept-bar" style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {weekly && (
        <section className="home-weekly-section" aria-label="本周部门统计">
          <header className="section-head">
            <div>
              <h2>本周部门统计</h2>
              <p className="lead">
                {weekly.from} ~ {weekly.to}：各部门新建需求数，以及本周首次解决的需求数。
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onExportWeekly()}
              disabled={exporting}
            >
              {exporting ? '导出中...' : '导出本周 PDF'}
            </button>
          </header>

          <div className="home-weekly-summary" aria-label="本周合计">
            <article>
              <p className="home-stat-label">本周提出</p>
              <p className="home-weekly-value">{weekly.submittedTotal}</p>
            </article>
            <article>
              <p className="home-stat-label">本周解决</p>
              <p className="home-weekly-value is-solved">{weekly.solvedTotal}</p>
            </article>
          </div>

          {weekly.departments.length === 0 ? (
            <p className="hint">本周暂无部门提需或解决记录</p>
          ) : (
            <div className="table-wrap home-weekly-table-wrap">
              <table className="data-table home-weekly-table">
                <thead>
                  <tr>
                    <th>部门</th>
                    <th>本周提出</th>
                    <th>本周解决</th>
                  </tr>
                </thead>
                <tbody>
                  {weekly.departments.map((row) => (
                    <tr key={row.name}>
                      <td title={row.name}>{row.name}</td>
                      <td>{row.submitted}</td>
                      <td>{row.solved}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>合计</td>
                    <td>{weekly.submittedTotal}</td>
                    <td>{weekly.solvedTotal}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="home-projects">
        <header className="section-head">
          <div>
            <h2>项目</h2>
            <p className="lead">每个项目一张卡片，展示需求数量与分布。</p>
          </div>
        </header>

        <form className="panel-form home-create-project" onSubmit={onCreateProject}>
          <h3>新建项目</h3>
          <label>
            项目名称
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
          </label>
          <label>
            描述
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </label>
          <button type="submit" disabled={creating}>
            {creating ? '创建中...' : '创建项目'}
          </button>
        </form>

        <div className="project-cards">
          {data.projects.map((p) => (
            <article key={p.id} className="project-card">
              <header className="project-card-head">
                <h3 title={p.name}>
                  <Link to={`/projects/${p.id}`}>{p.name.replace(/^\[测试\]/, '')}</Link>
                </h3>
                <span className="project-card-total">{p.requirementCount}</span>
              </header>
              <p className="project-card-desc" title={p.description || undefined}>
                {p.description || '暂无项目描述'}
              </p>
              <dl className="project-card-counts" aria-label="需求分布">
                <div className="is-todo">
                  <dt>待做</dt>
                  <dd>{p.counts.todo}</dd>
                </div>
                <div className="is-doing">
                  <dt>进行中</dt>
                  <dd>{p.counts.doing}</dd>
                </div>
                <div className="is-done">
                  <dt>已实现</dt>
                  <dd>{p.counts.done}</dd>
                </div>
                <div className="is-wont">
                  <dt>无法实现</dt>
                  <dd>{p.counts.wont}</dd>
                </div>
              </dl>
              <ul className="project-card-preview">
                {p.preview.length === 0 && <li className="is-empty">暂无需求预览</li>}
                {p.preview.slice(0, 3).map((req) => (
                  <li key={req.id}>
                    <Link
                      to={`/requirements/${req.id}`}
                      state={detailLinkState(returnPath)}
                      title={req.title}
                    >
                      <span className="project-card-preview-title">
                        {req.title.replace(/^\[测试\]/, '')}
                      </span>
                      <em>{req.statusLabel || req.status}</em>
                    </Link>
                  </li>
                ))}
              </ul>
              <footer className="project-card-foot">
                <Link to={`/projects/${p.id}`}>进入项目看板</Link>
              </footer>
            </article>
          ))}
        </div>
        {data.projects.length === 0 && <p className="hint">暂无项目。</p>}
      </section>
    </main>
  );
}

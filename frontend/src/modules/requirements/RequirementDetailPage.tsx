import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '@shared/api/client';
import { useAuth } from '@shared/auth/AuthContext';
import { canAcceptRequirement } from '@shared/auth/capabilities';
import { crumbLabel, resolveReturnTo } from '@shared/nav/returnTo';
import type { Priority, Requirement, ReqStatus } from '@shared/types/domain';
import { PRIORITY_LABEL, EXPECTED_LEVEL_LABEL, PROGRESS_ORDER, STATUS_LABEL } from '@shared/types/domain';
import { parseSceneDescription, SCENE_DETAIL_FIELDS } from '@shared/utils/sceneDescription';
import { formatDateTime } from '@shared/utils/datetime';
import { logger } from '@shared/logger/index';
import { toast } from '@shared/toast';
import { ConfirmDialog } from '@shared/components/ConfirmDialog';
import { ProgressTimeline } from './ProgressTimeline';

const log = logger.child({ module: 'requirement-detail' });

function formatDue(due?: string | null) {
  if (!due) return '未设置';
  return due.slice(0, 10);
}

export function RequirementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isExecutor, isRequester } = useAuth();
  const [item, setItem] = useState<Requirement | null>(null);
  const [priority, setPriority] = useState<Priority>('unset');
  const [priorityNote, setPriorityNote] = useState('');
  const [status, setStatus] = useState<ReqStatus>('evaluating');
  const [error, setError] = useState<string | null>(null);
  const [wontReason, setWontReason] = useState('');
  const [showWontForm, setShowWontForm] = useState(false);
  const [savingWont, setSavingWont] = useState(false);
  const [savingPriority, setSavingPriority] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const backTo = useMemo(
    () => resolveReturnTo((location.state as { from?: string } | null)?.from),
    [location.state],
  );
  const crumbRoot = crumbLabel(backTo);

  const load = async () => {
    if (!id) return;
    try {
      const data = await api.get<Requirement>(`/requirements/${id}`);
      setItem(data);
      setPriority(data.priority);
      setPriorityNote(data.priorityNote || '');
      setStatus(data.status === 'wont_impl' ? 'implementing' : data.status);
      setWontReason(data.wontReason || '');
      setShowWontForm(false);
      setError(null);
    } catch (err) {
      log.error('加载需求详情失败', err);
      setError(err instanceof Error ? err.message : '加载失败');
    }
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    setError(null);
    setItem(null);
    void load();
  }, [id]);

  const onSetPriority = async (e: FormEvent) => {
    e.preventDefault();
    if (!id || !item) return;
    if (item.status === 'evaluating' && priority === 'unset') {
      toast.error('请先选择具体优先级后再保存');
      return;
    }
    setSavingPriority(true);
    try {
      const data = await api.patch<Requirement>(`/requirements/${id}/priority`, {
        priority,
        note: priorityNote,
      });
      setItem(data);
      setStatus(data.status);
      toast.success(
        data.status === 'waiting_impl' && item.status === 'evaluating'
          ? '优先级已绑定，已进入「等待实现」'
          : '优先级已人工更新',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新优先级失败');
    } finally {
      setSavingPriority(false);
    }
  };

  const onUpdateFlow = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (status === 'wont_impl') {
      toast.error('无法实现请使用「标记无法实现」');
      return;
    }
    setSavingFlow(true);
    try {
      const data = await api.patch<Requirement>(`/requirements/${id}`, { status });
      setItem(data);
      setStatus(data.status);
      setWontReason(data.wontReason || '');
      setShowWontForm(false);
      toast.success(`状态已变更为「${data.statusLabel || STATUS_LABEL[data.status]}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSavingFlow(false);
    }
  };

  const onAccept = async () => {
    if (!id) return;
    setAccepting(true);
    try {
      const data = await api.patch<Requirement>(`/requirements/${id}`, { status: 'done' });
      setItem(data);
      setStatus(data.status);
      setAcceptOpen(false);
      toast.success('已验收完成');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '验收失败');
    } finally {
      setAccepting(false);
    }
  };

  const onDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api.delete(`/requirements/${id}`);
      toast.success('需求已删除');
      navigate(backTo, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const onConfirmWont = async (e: FormEvent) => {
    e.preventDefault();
    if (!id) return;
    if (!wontReason.trim()) {
      toast.error('请填写无法实现的原因');
      return;
    }
    setSavingWont(true);
    try {
      const data = await api.patch<Requirement>(`/requirements/${id}`, {
        status: 'wont_impl',
        wontReason: wontReason.trim(),
      });
      setItem(data);
      setStatus(data.status === 'wont_impl' ? 'implementing' : data.status);
      setWontReason(data.wontReason || '');
      setShowWontForm(false);
      toast.success('已标记为无法实现');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSavingWont(false);
    }
  };

  if (error && !item) {
    return (
      <main className="page detail-page">
        <p className="crumb">
          <Link to={backTo}>{crumbRoot}</Link>
        </p>
        <p className="error-text">{error}</p>
      </main>
    );
  }

  if (!item) {
    return (
      <main className="page detail-page">
        <p className="crumb">
          <Link to={backTo}>{crumbRoot}</Link>
        </p>
        <p>加载需求详情...</p>
      </main>
    );
  }

  const canAccept = canAcceptRequirement({
    status: item.status,
    requesterId: item.requesterId,
    userId: user?.id,
  });
  const needsPriority = item.status === 'evaluating';
  // 执行方推进到「等待验收」为止；「已验收完成」仅提需人确认
  const canAdvanceProgress = isExecutor && !needsPriority && item.status !== 'done';
  const canMarkWont = isExecutor && !needsPriority && item.status !== 'wont_impl' && item.status !== 'done';
  // 删除权限：执行方可删任意；需求方仅可删自己待评优先级的需求
  const canDelete = isExecutor || (isRequester && item.status === 'evaluating');
  // 主链节点选项：当前节点 + 前一档（撤销误操作）+ 后续节点；「无法实现」下仅恢复选项
  const advanceableNodes = PROGRESS_ORDER.filter((node) => {
    if (node.code === 'evaluating' || node.code === 'wont_impl' || node.code === 'done') return false;
    if (item.status === 'wont_impl') {
      return node.code === 'implementing' || node.code === 'pending_accept';
    }
    const curIdx = PROGRESS_ORDER.findIndex((n) => n.code === item.status);
    const nextIdx = PROGRESS_ORDER.findIndex((n) => n.code === node.code);
    return nextIdx >= Math.max(0, curIdx - 1);
  });
  const flowLocked = advanceableNodes.length <= 1;
  const scene = parseSceneDescription(item.description);

  return (
    <main className="page detail-page">
      <p className="crumb">
        <Link to={backTo}>{crumbRoot}</Link>
        <span aria-hidden="true"> / </span>
        <span className="crumb-current" title={item.title}>
          {item.title}
        </span>
      </p>

      <header className="section-head">
        <div>
          <h1>{item.title}</h1>
          <p className="lead">
            项目：
            {isExecutor ? (
              <Link to={`/projects/${item.projectId}`}>{item.projectName || item.projectId}</Link>
            ) : (
              <span>{item.projectName || item.projectId}</span>
            )}
            {' · '}
            当前节点：{item.statusLabel || STATUS_LABEL[item.status]}
            {' · '}
            期望完成：{formatDue(item.dueDate)}
          </p>
          {canAccept && (
            <p className="hint accept-hint">实现方已提交验收，请确认是否通过。</p>
          )}
        </div>
        <div className="section-head-actions">
          {canAccept && (
            <button type="button" className="btn-primary" onClick={() => setAcceptOpen(true)}>
              确认验收通过
            </button>
          )}
          {canMarkWont && !showWontForm && (
            <button
              type="button"
              className="btn-wont"
              onClick={() => {
                setShowWontForm(true);
                setError(null);
              }}
            >
              标记无法实现
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn-wont"
              onClick={() => setDeleteOpen(true)}
            >
              删除
            </button>
          )}
        </div>
      </header>

      {showWontForm && (
        <form className="panel-form wont-reason-form" onSubmit={(e) => void onConfirmWont(e)}>
          <h2>标记为无法实现</h2>
          <p className="hint">请说明无法实现的原因，需求方将能看到该说明。</p>
          <label>
            无法实现原因
            <textarea
              value={wontReason}
              onChange={(e) => setWontReason(e.target.value)}
              rows={4}
              required
              placeholder="例如：技术方案不可行、资源不足、与现有架构冲突等"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn-wont" disabled={savingWont}>
              {savingWont ? '提交中...' : '确认无法实现'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setShowWontForm(false);
                setWontReason(item.wontReason || '');
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      <ProgressTimeline nodes={item.progressNodes || []} />

      <section className="detail-grid">
        <article className="detail-main">
          <h2>需求详情</h2>

          <div className="detail-value-block">
            <h3>问题与影响</h3>
            {scene.structured ? (
              <dl className="meta-list meta-list-stacked">
                {SCENE_DETAIL_FIELDS.map(({ key, label }) => {
                  const value = scene[key];
                  if (!value) return null;
                  return (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="detail-body detail-body-inline">{scene.raw || '暂无描述'}</p>
            )}
          </div>

          <div className="detail-value-block">
            <h3>价值与预期</h3>
            <dl className="meta-list meta-list-stacked">
              <div>
                <dt>预期效果</dt>
                <dd>{item.afterImpl || '-'}</dd>
              </div>
              {/* 新表单已把频率/影响写入「问题与影响」，避免与 implValue/efficiencyGain 重复 */}
              {!(scene.structured && (scene.frequency || scene.reach || scene.impact)) && (
                <>
                  <div>
                    <dt>业务价值</dt>
                    <dd>{item.implValue || '-'}</dd>
                  </div>
                  <div>
                    <dt>效率收益</dt>
                    <dd>{item.efficiencyGain || '-'}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>期望优先级</dt>
                <dd>{EXPECTED_LEVEL_LABEL[item.expectedLevel || 'unset']}</dd>
              </div>
              <div>
                <dt>期望完成时间</dt>
                <dd>{formatDue(item.dueDate)}</dd>
              </div>
            </dl>
          </div>

          {item.status === 'wont_impl' && item.wontReason && (
            <div className="wont-reason-box">
              <h3>无法实现原因</h3>
              <p>{item.wontReason}</p>
            </div>
          )}

          {item.attachments && item.attachments.length > 0 && (
            <div className="attachment-grid">
              <h3>参考附件</h3>
              <ul>
                {item.attachments.map((att) => (
                  <li key={att.id}>
                    <a href={att.url} target="_blank" rel="noreferrer">
                      {att.contentType === 'application/pdf' || /\.pdf$/i.test(att.fileName) ? (
                        <span className="attachment-pdf-preview" aria-hidden="true">PDF</span>
                      ) : (
                        <img src={att.url} alt={att.fileName} />
                      )}
                      <span>{att.fileName}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="meta-list">
            <div>
              <dt>状态</dt>
              <dd>
                <span className={`status-badge status-${item.status}`}>
                  {item.statusLabel || STATUS_LABEL[item.status]}
                </span>
              </dd>
            </div>
            <div>
              <dt>优先级</dt>
              <dd>
                <span className={`prio-tag prio-${item.priority || 'unset'}`}>
                  {PRIORITY_LABEL[item.priority]}
                </span>
              </dd>
            </div>
            <div>
              <dt>提交人</dt>
              <dd>{item.requesterName || item.requesterId}</dd>
            </div>
            <div>
              <dt>所属部门</dt>
              <dd>{scene.department || '-'}</dd>
            </div>
            <div>
              <dt>处理方</dt>
              <dd>{item.assigneeName || '-'}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatDateTime(item.createdAt)}</dd>
            </div>
          </dl>
          {item.priorityNote && <p className="hint">优先级备注：{item.priorityNote}</p>}
        </article>

        {isExecutor && (
          <aside className="detail-side">
            {needsPriority && (
              <form className="panel-form" onSubmit={onSetPriority}>
                <h2>绑定优先级</h2>
                <p className="hint">当前处于待评优先级，请先绑定优先级；保存后将进入「等待实现」，才可推进进度节点。</p>
                <label>
                  优先级
                  <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                    {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  评判说明
                  <textarea
                    value={priorityNote}
                    onChange={(e) => setPriorityNote(e.target.value)}
                    rows={3}
                    placeholder="说明为何给出该优先级"
                  />
                </label>
                <button type="submit" disabled={savingPriority}>
                  {savingPriority ? '保存中...' : '绑定并进入下一阶段'}
                </button>
              </form>
            )}

            {canAdvanceProgress && (
              <form className="panel-form" onSubmit={onUpdateFlow}>
                <h2>推进进度节点</h2>
                <p className="hint">
                  可推进至「已实现等待验收」；验收完成须由需求提出人确认。执行人已锁定，不可修改。
                </p>
                <label>
                  进度节点
                  <select value={status} onChange={(e) => setStatus(e.target.value as ReqStatus)}>
                    {advanceableNodes.map((node) => (
                      <option key={node.code} value={node.code}>
                        {node.label}
                        {node.code === item.status ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={savingFlow || flowLocked}>
                  {savingFlow ? '更新中...' : flowLocked ? '当前节点不可回退' : '更新节点'}
                </button>
              </form>
            )}
          </aside>
        )}
      </section>

      {acceptOpen && (
        <ConfirmDialog
          title="确认验收通过"
          description={`确认「${item.title}」已实现且验收通过？此操作不可回退。`}
          confirmLabel="确认验收"
          cancelLabel="再检查一下"
          busy={accepting}
          onConfirm={() => void onAccept()}
          onCancel={() => setAcceptOpen(false)}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title="删除需求"
          description={`确定删除「${item.title}」？需求及其附件、进度记录将一并删除，此操作不可恢复。`}
          confirmLabel="确认删除"
          cancelLabel="取消"
          danger
          busy={deleting}
          onConfirm={() => void onDelete()}
          onCancel={() => setDeleteOpen(false)}
        />
      )}
    </main>
  );
}

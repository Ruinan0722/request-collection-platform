import { FormEvent, useEffect, useId, useMemo, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@shared/api/client';
import { useAuth, type AuthUser } from '@shared/auth/AuthContext';
import { canCreateRequirement } from '@shared/auth/capabilities';
import { defaultExecutorOrgLabel } from '@shared/auth/executorOrgs';
import { detailLinkState, rememberReturnTo } from '@shared/nav/returnTo';
import type { Priority, Project, Requirement, RequirementAttachment } from '@shared/types/domain';
import { logger } from '@shared/logger/index';
import { toast } from '@shared/toast';

const log = logger.child({ module: 'requirement-create' });

const MAX_FILES = 8;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

const FREQUENCY_OPTIONS = ['每天多次', '每天', '每周', '每月', '偶发'] as const;
const REACH_OPTIONS = ['仅自己', '2-10 人', '11-50 人', '50 人以上', '外部客户'] as const;
const IMPACT_OPTIONS = [
  '有些不便',
  '明显耗时或易错',
  '影响关键工作',
  '工作已停滞',
  '客户/合规/重大风险',
] as const;

type Frequency = (typeof FREQUENCY_OPTIONS)[number];
type Reach = (typeof REACH_OPTIONS)[number];
type Impact = (typeof IMPACT_OPTIONS)[number];

const TIP_STEPS = [
  { label: '问题描述', hint: '说清楚在做什么、卡在哪一步，尽量具体' },
  { label: '期望变化', hint: '写理想结果，可带数字；不用设计技术方案' },
  { label: '影响评估', hint: '选频率、影响人数和当前影响，方便排优先级' },
  { label: '业务节点', hint: '有交付/上线/合规等硬节点就填日期，没有可跳过' },
  { label: '截图示例', hint: '可选；上传脱敏后的界面或样例更利于理解' },
] as const;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function impactToExpectedLevel(impact: Impact): Priority {
  switch (impact) {
    case '客户/合规/重大风险':
    case '工作已停滞':
      return 'p0';
    case '影响关键工作':
      return 'p1';
    case '明显耗时或易错':
      return 'p2';
    default:
      return 'p3';
  }
}

function buildTitleFromProblem(problem: string): string {
  const compact = problem.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const firstSentence = compact.split(/[。！？\n]/)[0]?.trim() || compact;
  return firstSentence.length > 48 ? `${firstSentence.slice(0, 48)}…` : firstSentence;
}

interface BatchRequirementRow {
  problem: string;
  result: string;
  dueDate: string;
}

const BATCH_TEMPLATE = `问题描述,期望结果,业务节点日期\n每次客户会议后需要手动整理纪要,会议结束后自动生成可确认的纪要,2026-09-30\n`;

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseBatchTemplate(raw: string): { rows: BatchRequirementRow[]; error: string | null } {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows: [], error: '模板内容为空' };
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const first = splitDelimitedLine(lines[0], delimiter).map((cell) => cell.replace(/^\s+|\s+$/g, ''));
  const normalized = first.map((cell) => cell.replace(/[「」【】]/g, ''));
  const problemIndex = normalized.findIndex((cell) => /问题描述|问题/.test(cell));
  const resultIndex = normalized.findIndex((cell) => /期望结果|希望结果|期望变化/.test(cell));
  const dateIndex = normalized.findIndex((cell) => /业务节点|日期|截止/.test(cell));
  const hasHeader = problemIndex >= 0 || resultIndex >= 0;
  const start = hasHeader ? 1 : 0;
  const rows = lines.slice(start).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    return {
      problem: (cells[hasHeader ? problemIndex : 0] || '').trim(),
      result: (cells[hasHeader ? resultIndex : 1] || '').trim(),
      dueDate: (cells[hasHeader && dateIndex >= 0 ? dateIndex : 2] || '').trim(),
    };
  }).filter((row) => row.problem || row.result || row.dueDate);
  if (!rows.length) return { rows: [], error: '模板中没有可导入的需求' };
  if (rows.length > 100) return { rows: rows.slice(0, 100), error: '一次最多导入 100 条需求' };
  const invalid = rows.findIndex((row) => !row.problem || !row.result);
  return {
    rows,
    error: invalid >= 0 ? `第 ${invalid + start + 1} 行缺少问题描述或期望结果` : null,
  };
}

function buildDescription(parts: {
  department: string;
  who: string;
  problem: string;
  frequency: Frequency;
  reach: Reach;
  impact: Impact;
  hasMilestone: boolean;
  dueDate: string;
}) {
  return [
    `【部门】${parts.department}`,
    `【相关人员】${parts.who}`,
    `【问题描述】\n${parts.problem}`,
    `【发生频率】${parts.frequency}`,
    `【影响人数】${parts.reach}`,
    `【当前影响】${parts.impact}`,
    parts.hasMilestone && parts.dueDate
      ? `【业务节点】有，必须赶上 ${parts.dueDate}`
      : '【业务节点】没有明确节点',
  ].join('\n');
}

function ChipGroup<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
  error,
}: {
  name: string;
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  error?: string;
}) {
  return (
    <fieldset className={`issue-chip-group ${error ? 'is-invalid' : ''}`}>
      <legend>{label}</legend>
      <div className="issue-chip-row" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const active = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              className={`issue-chip ${active ? 'is-active' : ''}`}
              onClick={() => onChange(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      <input type="hidden" name={name} value={value} readOnly />
      {error && <span className="field-error">{error}</span>}
    </fieldset>
  );
}

function SimpleRequesterSubmit({
  user,
  projects,
  loading,
  loadError,
}: {
  user: AuthUser;
  projects: Project[];
  loading: boolean;
  loadError: string | null;
}) {
  const navigate = useNavigate();
  const [problem, setProblem] = useState('');
  const [afterImpl, setAfterImpl] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('我的需求');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Array<{ file: File; url: string }>>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>(projects);
  const [defaultProjectAttempted, setDefaultProjectAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchText, setBatchText] = useState('');
  const [batchRows, setBatchRows] = useState<BatchRequirementRow[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

  useEffect(() => {
    if (!projectId && projectOptions.length > 0) {
      const crmProject = projectOptions.find((project) => /crm/i.test(project.name));
      setProjectId((crmProject || projectOptions[0]).id);
    }
  }, [projectOptions, projectId]);

  useEffect(() => {
    setProjectOptions(projects);
  }, [projects]);

  useEffect(() => {
    const availableProjects = projectOptions.length > 0 ? projectOptions : projects;
    if (loading || loadError || defaultProjectAttempted || availableProjects.some((project) => /crm/i.test(project.name))) return;
    setDefaultProjectAttempted(true);
    void api.post<Project>('/projects', {
      name: 'CRM',
      description: 'CRM 相关需求集合',
    }).then((created) => {
      setProjectOptions((current) => [created, ...current]);
      setProjectId(created.id);
    }).catch((err) => {
      log.error('创建默认 CRM 项目失败', err);
    });
  }, [defaultProjectAttempted, loadError, loading, projectOptions, projects]);

  useEffect(() => {
    const next = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(next);
    return () => next.forEach((item) => URL.revokeObjectURL(item.url));
  }, [files]);

  const department = user.departmentNames?.join(' · ') || '未绑定部门';
  const missingProject = projectOptions.length === 0 && !projectId;

  const addFiles = (incoming: File[]) => {
    if (!incoming.length) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of incoming) {
      if (!ACCEPT_TYPES.includes(file.type)) rejected.push(`${file.name}（格式不支持）`);
      else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name}（超过 5MB）`);
      else accepted.push(file);
    }
    setFiles((current) => {
      const room = Math.max(0, MAX_FILES - current.length);
      if (accepted.length > room) rejected.push(`最多上传 ${MAX_FILES} 个附件`);
      return [...current, ...accepted.slice(0, room)];
    });
    setError(rejected.length ? `部分附件未添加：${rejected.join('、')}` : null);
  };

  const onPickFiles = (picked: FileList | null) => {
    if (picked?.length) addFiles(Array.from(picked));
  };

  const onDropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  };

  const onPasteClipboard = (event: ClipboardEvent<HTMLElement>) => {
    const pasted = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (pasted.length) {
      event.preventDefault();
      addFiles(pasted.map((file, index) => new File([file], `在线截图-${Date.now()}-${index + 1}.png`, { type: file.type })));
    }
  };

  const removeFile = (index: number) => setFiles((current) => current.filter((_, i) => i !== index));

  const readBatchText = (text: string) => {
    setBatchText(text);
    const parsed = parseBatchTemplate(text);
    setBatchRows(parsed.rows);
    setBatchError(parsed.error);
  };

  const onBatchFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name) && file.type !== 'text/csv' && file.type !== 'text/plain') {
      setBatchError('请上传 CSV 或 TXT 格式的模板文件');
      return;
    }
    readBatchText(await file.text());
  };

  const downloadBatchTemplate = () => {
    const blob = new Blob([`\uFEFF${BATCH_TEMPLATE}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '需求批量导入模板.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onBatchSubmit = async () => {
    if (!batchRows.length || batchError) {
      setBatchError('请先上传或粘贴正确的模板内容');
      return;
    }
    setBatchSubmitting(true);
    setBatchProgress('正在准备项目...');
    setBatchError(null);
    try {
      let selectedProjectId = projectId;
      if (!selectedProjectId) {
        const project = await api.post<Project>('/projects', {
          name: newProjectName.trim() || 'CRM',
          description: 'CRM 相关需求集合',
        });
        selectedProjectId = project.id;
      }
      for (let index = 0; index < batchRows.length; index += 1) {
        const row = batchRows[index];
        if (row.dueDate) {
          const due = new Date(`${row.dueDate}T00:00:00`);
          if (Number.isNaN(due.getTime())) throw new Error(`第 ${index + 1} 条业务节点日期格式无效`);
        }
        setBatchProgress(`正在提交第 ${index + 1}/${batchRows.length} 条...`);
        const created = await api.post<Requirement>('/requirements', {
          projectId: selectedProjectId,
          title: buildTitleFromProblem(row.problem),
          description: [`【部门】${department}`, `【问题描述】\n${row.problem}`, `【希望结果】\n${row.result}`, row.dueDate ? `【业务节点】${row.dueDate}` : '【业务节点】暂无明确日期'].join('\n'),
          afterImpl: row.result,
          implValue: '来自批量导入模板',
          efficiencyGain: '',
          expectedLevel: 'unset',
          dueDate: row.dueDate || null,
        });
        if (!created.id) throw new Error(`第 ${index + 1} 条需求提交失败`);
      }
      toast.success(`已批量提交 ${batchRows.length} 条需求`);
      setBatchText('');
      setBatchRows([]);
      setBatchProgress('');
    } catch (err) {
      log.error('批量导入需求失败', err);
      setBatchError(err instanceof Error ? err.message : '批量提交失败，请检查模板后重试');
      setBatchProgress('');
    } finally {
      setBatchSubmitting(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const cleanProblem = problem.trim();
    const cleanResult = afterImpl.trim();
    const generatedTitle = buildTitleFromProblem(cleanProblem);
    if (!cleanProblem || !cleanResult) {
      setError('请补充遇到的问题和希望的结果');
      return;
    }
    if (targetDate) {
      const target = new Date(`${targetDate}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (Number.isNaN(target.getTime()) || target < today) {
        setError('业务节点日期不能早于今天');
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      let selectedProjectId = projectId;
      if (!selectedProjectId) {
        const project = await api.post<Project>('/projects', {
          name: newProjectName.trim() || '我的需求',
          description: '由需求方提交的日常需求集合',
        });
        selectedProjectId = project.id;
      }
      const created = await api.post<Requirement>('/requirements', {
        projectId: selectedProjectId,
        title: generatedTitle,
        description: [`【部门】${department}`, `【问题描述】\n${cleanProblem}`, `【希望结果】\n${cleanResult}`,
          targetDate ? `【业务节点】${targetDate}` : '【业务节点】暂无明确日期'].join('\n'),
        afterImpl: cleanResult,
        implValue: '来自简化提需模板',
        efficiencyGain: '',
        expectedLevel: 'unset',
        dueDate: targetDate || null,
      });
      for (const file of files) {
        await api.upload<RequirementAttachment>(`/requirements/${created.id}/attachments`, file);
      }
      toast.success('需求已提交，接收方会在进度页更新状态');
      rememberReturnTo('/requirements?view=board');
      navigate(`/requirements/${created.id}`, {
        replace: true,
        state: detailLinkState('/requirements?view=board'),
      });
    } catch (err) {
      log.error('简化提需提交失败', err);
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <main className="page"><p className="hint">正在准备提需模板...</p></main>;
  }

  return (
    <main className="page simple-submit-page">
      <header className="simple-submit-head">
        <div>
          <p className="eyebrow">提一条需求</p>
          <h1>用 3 分钟，把想法说清楚</h1>
        </div>
        <div className="simple-submit-count"><strong>2</strong><span>/ 2 个必填问题</span></div>
      </header>

      <form className="simple-submit-layout" onSubmit={(event) => void onSubmit(event)} noValidate>
        <div className="simple-submit-main">
          <section className="simple-submit-card">
            <div className="simple-submit-card-head"><span>01</span><div><h2>现在遇到了什么？<em>*</em></h2></div></div>
            <label className="simple-submit-field"><span>问题描述</span><textarea autoFocus value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={1000} rows={5} placeholder="例如：每次客户会议后，我要听录音、整理纪要，再手动录入 CRM，平均要花 30 分钟。" /></label>
          </section>

          <section className="simple-submit-card">
            <div className="simple-submit-card-head"><span>02</span><div><h2>解决后希望怎样？<em>*</em></h2></div></div>
            <label className="simple-submit-field"><span>期望结果</span><textarea value={afterImpl} onChange={(e) => setAfterImpl(e.target.value)} maxLength={1000} rows={4} placeholder="例如：会议结束后 5 分钟内生成可确认的纪要，并自动提取下一步行动。" /></label>
          </section>

          <section className="simple-submit-card simple-submit-card-optional">
            <div className="simple-submit-card-head"><span>03</span><div><h2>有必须赶上的日期吗？<small>可选</small></h2></div></div>
            <label className="simple-submit-field simple-submit-date"><span>业务节点日期</span><input type="date" min={new Date().toISOString().slice(0, 10)} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label>
          </section>

          <section className="simple-submit-card simple-submit-card-optional" onPaste={onPasteClipboard}>
            <div className="simple-submit-card-head"><span>04</span><div><h2>补充图片、截图或 PDF<small>可选</small></h2></div></div>
            <div className="simple-submit-upload-grid" onDragOver={(event) => event.preventDefault()} onDrop={onDropFiles}>
              {previews.map((item, index) => <figure key={`${item.file.name}-${item.file.size}-${index}`} className="simple-submit-thumb">{item.file.type === 'application/pdf' ? <div className="simple-submit-pdf-preview"><strong>PDF</strong><span>文档附件</span></div> : <img src={item.url} alt={item.file.name} />}<figcaption><span title={item.file.name}>{item.file.name}</span><em>{formatSize(item.file.size)}</em></figcaption><button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => removeFile(index)}>×</button></figure>)}
              {files.length < MAX_FILES && <label className="simple-submit-upload"><input type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.pdf" multiple onChange={(e) => { onPickFiles(e.target.files); e.target.value = ''; }} /><span>＋</span><strong>{files.length ? '继续添加附件' : '上传图片 / PDF'}</strong><small>支持拖拽 · Ctrl+V 粘贴截图 · 单个 ≤ 5MB</small></label>}
            </div>
          </section>

          {projectOptions.length > 0 && <label className="simple-submit-project"><span>关联项目</span><select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}{/crm/i.test(project.name) ? '（默认）' : ''}</option>)}</select></label>}
          {missingProject && <label className="simple-submit-project"><span>给这一批需求起个名字</span><input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} maxLength={128} placeholder="例如：销售日常需求" /></label>}
          <section className="simple-submit-batch-card">
            <div className="simple-submit-batch-head"><div><p className="eyebrow">批量提需求</p><h2>也可以一次提交多条</h2></div><div className="simple-submit-batch-actions"><button type="button" className="btn-secondary" onClick={downloadBatchTemplate}>下载 CSV 模板</button><label className="btn-secondary simple-submit-batch-file">上传模板<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => { void onBatchFile(event.target.files?.[0]); event.target.value = ''; }} /></label></div></div>
            <textarea aria-label="批量模板内容" value={batchText} onChange={(event) => readBatchText(event.target.value)} rows={5} placeholder="问题描述,期望结果,业务节点日期\n例如：客户会议后整理纪要耗时,会议结束后自动生成纪要,2026-09-30" />
            {batchRows.length > 0 && <div className="simple-submit-batch-preview"><strong>已识别 {batchRows.length} 条需求</strong><div>{batchRows.slice(0, 4).map((row, index) => <p key={`${row.problem}-${index}`}><span>{index + 1}</span><b>{row.problem || '缺少问题描述'}</b><em>{row.result || '缺少期望结果'}</em></p>)}{batchRows.length > 4 && <small>还有 {batchRows.length - 4} 条未展开</small>}</div></div>}
            {batchError && <p className="error-text">{batchError}</p>}
            <div className="simple-submit-batch-footer">{batchProgress && <span>{batchProgress}</span>}<button type="button" className="btn-primary" disabled={batchSubmitting || !batchRows.length || !!batchError} onClick={() => void onBatchSubmit()}>{batchSubmitting ? '批量提交中...' : `提交 ${batchRows.length || ''} 条需求`}</button></div>
          </section>
          <section className="simple-submit-generated-title"><span>提交前看一眼自动生成的标题（无需填写）</span><strong>{buildTitleFromProblem(problem) || '填写问题描述后，这里会自动出现标题'}</strong></section>
          {(loadError || error) && <p className="error-text">{loadError || error}</p>}
          <footer className="simple-submit-footer"><button type="submit" className="btn-primary" disabled={submitting}>{submitting ? '提交中...' : '提交这条需求 →'}</button></footer>
        </div>
        <aside className="simple-submit-guide"><p className="eyebrow">填写范例</p><h2>两句话就够了</h2><ol><li><strong>问题描述：</strong>现在做什么事情最麻烦？</li><li><strong>期望结果：</strong>解决后希望节省什么、提升什么？</li><li><strong>补充材料：</strong>有截图就上传，没有也不影响提交。</li></ol><div className="simple-submit-guide-note"><strong>标题会自动生成</strong></div></aside>
      </form>
    </main>
  );
}

export function RequirementCreatePage() {
  const { user, isExecutor, loading: authLoading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const formId = useId();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState(params.get('projectId') || '');
  const [problem, setProblem] = useState('');
  const [afterImpl, setAfterImpl] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('每周');
  const [reach, setReach] = useState<Reach>('2-10 人');
  const [impact, setImpact] = useState<Impact>('明显耗时或易错');
  const [hasMilestone, setHasMilestone] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [title, setTitle] = useState('');
  const [checkHint, setCheckHint] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Array<{ file: File; url: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  const departmentLabel =
    user?.departmentNames && user.departmentNames.length > 0
      ? user.departmentNames.join(' · ')
      : '未绑定部门';

  const identityLabel = useMemo(() => {
    return `${user?.name || '当前用户'} | ${departmentLabel}`;
  }, [user?.name, departmentLabel]);

  useEffect(() => {
    const next = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPreviews(next);
    return () => {
      for (const item of next) URL.revokeObjectURL(item.url);
    };
  }, [files]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const list = await api.get<Project[]>('/projects');
        if (cancelled) return;
        setProjects(list);
        setProjectId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          return list[0]?.id || '';
        });
        setError(null);
      } catch (err) {
        log.error('加载提需求表单失败', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载失败，请刷新重试');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authLoading && !canCreateRequirement(user?.role)) {
    return <Navigate to="/requirements" replace />;
  }

  const executorLabel = defaultExecutorOrgLabel();

  if (!authLoading && user && !isExecutor) {
    return <SimpleRequesterSubmit user={user} projects={projects} loading={loading} loadError={error} />;
  }

  const validate = (resolvedTitle: string) => {
    const next: Record<string, string> = {};
    if (!projectId) next.projectId = '请选择要关联的项目';
    if (!problem.trim()) next.problem = '请描述发生了什么问题';
    if (!afterImpl.trim()) next.afterImpl = '请描述解决后希望有什么变化';
    if (hasMilestone) {
      if (!dueDate) next.dueDate = '请填写必须赶上的节点日期';
      else {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(`${dueDate}T00:00:00`);
        if (Number.isNaN(due.getTime())) next.dueDate = '节点日期无效';
        else if (due < today) next.dueDate = '节点日期不能早于今天';
      }
    }
    if (!resolvedTitle.trim()) next.title = '请填写需求标题，或先点击「检查并生成标题」';
    setFieldError(next);
    return Object.keys(next).length === 0;
  };

  const onPickFiles = (picked: FileList | null) => {
    if (!picked?.length) return;
    const incoming = Array.from(picked);
    const rejected: string[] = [];
    const accepted: File[] = [];

    for (const file of incoming) {
      if (!ACCEPT_TYPES.includes(file.type)) {
        rejected.push(`${file.name}（格式不支持）`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}（超过 5MB）`);
        continue;
      }
      accepted.push(file);
    }

    let overflow = false;
    setFiles((prev) => {
      const room = Math.max(0, MAX_FILES - prev.length);
      overflow = accepted.length > room;
      return [...prev, ...accepted.slice(0, room)];
    });
    if (overflow) rejected.push(`最多上传 ${MAX_FILES} 张图片`);

    if (rejected.length) {
      setError(`部分文件未添加：${rejected.join('、')}`);
    } else {
      setError(null);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const onTitleCheck = () => {
    const issues: string[] = [];
    if (!problem.trim()) issues.push('问题描述');
    if (!afterImpl.trim()) issues.push('期望变化');
    if (hasMilestone && !dueDate) issues.push('业务节点日期');
    if (!projectId) issues.push('关联项目');

    if (issues.length) {
      setCheckHint(`还缺：${issues.join('、')}。补全后再生成标题。`);
      return;
    }

    const generated = buildTitleFromProblem(problem);
    setTitle(generated);
    setCheckHint('信息较完整。已根据问题描述生成标题，可再微调后提交。');
    setFieldError((f) => ({ ...f, title: '', problem: '', afterImpl: '' }));
  };

  const onCreateProject = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newProjectName.trim();
    if (!trimmed) {
      setError('请填写项目名称');
      return;
    }
    setCreatingProject(true);
    setError(null);
    try {
      const created = await api.post<Project>('/projects', { name: trimmed });
      setProjects((prev) => [created, ...prev]);
      setProjectId(created.id);
      setNewProjectName('');
      setFieldError((f) => ({ ...f, projectId: '' }));
      toast.success(`项目「${created.name}」已创建并选中`);
    } catch (err) {
      log.error('创建项目失败', err);
      setError(err instanceof Error ? err.message : '创建项目失败');
    } finally {
      setCreatingProject(false);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const resolvedTitle = (title.trim() || buildTitleFromProblem(problem)).trim();
    if (resolvedTitle && resolvedTitle !== title.trim()) {
      setTitle(resolvedTitle);
    }

    if (!validate(resolvedTitle)) {
      setError('请完善必填信息后再提交');
      return;
    }
    if (projects.length === 0) {
      setError(
        isExecutor
          ? '暂无可用项目，请先在工作台创建项目，或在下方新建'
          : '暂无可用项目，请先在下方新建项目',
      );
      return;
    }

    setSubmitting(true);
    try {
      const whoName = (user?.name || '').trim() || '当前用户';
      const description = buildDescription({
        department: departmentLabel,
        who: whoName,
        problem: problem.trim(),
        frequency,
        reach,
        impact,
        hasMilestone,
        dueDate,
      });
      const created = await api.post<Requirement>('/requirements', {
        projectId,
        title: resolvedTitle,
        description,
        afterImpl: afterImpl.trim(),
        implValue: `影响范围：${reach}；当前影响：${impact}`,
        efficiencyGain: `发生频率：${frequency}`,
        expectedLevel: impactToExpectedLevel(impact),
        dueDate: hasMilestone && dueDate ? dueDate : null,
      });
      for (const file of files) {
        await api.upload<RequirementAttachment>(`/requirements/${created.id}/attachments`, file);
      }
      rememberReturnTo('/requirements');
      navigate(`/requirements/${created.id}`, {
        replace: true,
        state: detailLinkState('/requirements'),
      });
    } catch (err) {
      log.error('提交需求失败', err);
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page issue-page">
      {loading ? (
        <p className="hint submit-loading">正在准备表单...</p>
      ) : (
        <div className="issue-layout">
          <form className="issue-form" id={formId} onSubmit={(e) => void onSubmit(e)} noValidate>
          <header className="issue-identity">
            <div className="issue-identity-main">
              <span className="issue-avatar" aria-hidden="true">
                {(user?.name || '用').trim().slice(0, 1) || '用'}
              </span>
              <p>
                将以 <strong>{identityLabel}</strong> 的身份提交
              </p>
            </div>
          </header>

          <section className="issue-block" aria-labelledby={`${formId}-q1`}>
            <header className="issue-block-head">
              <span className="issue-step">1</span>
              <div>
                <h2 id={`${formId}-q1`}>
                  发生了什么问题？<em>*</em>
                </h2>
                <p>说清楚是什么事情、现在怎么处理，以及最麻烦的是哪一步。</p>
              </div>
            </header>
            <label className={`issue-field ${fieldError.problem ? 'is-invalid' : ''}`}>
              <textarea
                value={problem}
                onChange={(e) => {
                  setProblem(e.target.value);
                  setFieldError((f) => ({ ...f, problem: '', title: '' }));
                }}
                rows={5}
                required
                placeholder="例如：每次客户会议后，我需要听录音整理纪要，再手动录入 CRM。每天约 5 次，每次约 30 分钟，还容易漏掉客户的关键诉求。"
              />
              {fieldError.problem && <span className="field-error">{fieldError.problem}</span>}
            </label>
          </section>

          <section className="issue-block" aria-labelledby={`${formId}-q2`}>
            <header className="issue-block-head">
              <span className="issue-step">2</span>
              <div>
                <h2 id={`${formId}-q2`}>
                  解决后，希望有什么变化？<em>*</em>
                </h2>
                <p>描述理想结果即可，不用设计技术方案；有数字会更有帮助。</p>
              </div>
            </header>
            <label className={`issue-field ${fieldError.afterImpl ? 'is-invalid' : ''}`}>
              <textarea
                value={afterImpl}
                onChange={(e) => {
                  setAfterImpl(e.target.value);
                  setFieldError((f) => ({ ...f, afterImpl: '' }));
                }}
                rows={4}
                required
                placeholder="例如：会议结束后 5 分钟内生成可确认的纪要，并自动提取客户诉求和下一步行动。"
              />
              {fieldError.afterImpl && <span className="field-error">{fieldError.afterImpl}</span>}
            </label>
          </section>

          <section className="issue-block" aria-labelledby={`${formId}-q3`}>
            <header className="issue-block-head">
              <span className="issue-step">3</span>
              <div>
                <h2 id={`${formId}-q3`}>这个问题影响多大？</h2>
                <p>点击最符合实际情况的选项，帮助我们判断处理顺序。</p>
              </div>
            </header>
            <div className="issue-impact-stack">
              <ChipGroup
                name="frequency"
                label="发生频率"
                options={FREQUENCY_OPTIONS}
                value={frequency}
                onChange={setFrequency}
              />
              <ChipGroup
                name="reach"
                label="影响人数"
                options={REACH_OPTIONS}
                value={reach}
                onChange={setReach}
              />
              <ChipGroup
                name="impact"
                label="当前影响"
                options={IMPACT_OPTIONS}
                value={impact}
                onChange={setImpact}
              />
            </div>
          </section>

          <section className="issue-block" aria-labelledby={`${formId}-q4`}>
            <header className="issue-block-head">
              <span className="issue-step">4</span>
              <div>
                <h2 id={`${formId}-q4`}>是否有必须赶上的业务节点？</h2>
                <p>例如客户交付、活动上线、审计合规或旧系统停用；没有可以直接跳过。</p>
              </div>
            </header>
            <div className="issue-toggle-row" role="radiogroup" aria-label="业务节点">
              <button
                type="button"
                role="radio"
                aria-checked={!hasMilestone}
                className={`issue-toggle ${!hasMilestone ? 'is-active' : ''}`}
                onClick={() => {
                  setHasMilestone(false);
                  setDueDate('');
                  setFieldError((f) => ({ ...f, dueDate: '' }));
                }}
              >
                没有明确节点
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={hasMilestone}
                className={`issue-toggle ${hasMilestone ? 'is-active' : ''}`}
                onClick={() => setHasMilestone(true)}
              >
                有，必须赶上
              </button>
            </div>
            {hasMilestone && (
              <div className={`issue-date-panel ${fieldError.dueDate ? 'is-invalid' : ''}`}>
                <div className="issue-date-panel-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <rect
                      x="3.5"
                      y="5"
                      width="17"
                      height="15.5"
                      rx="2.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <path
                      d="M3.5 10h17M8 3.5v3.5M16 3.5v3.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <label className="issue-date-panel-body">
                  <span className="issue-date-panel-label">
                    节点日期<em>*</em>
                  </span>
                  <span className="issue-date-panel-hint">请选择必须赶上的业务日期，不可早于今天</span>
                  <span className="issue-date-input-wrap">
                    <input
                      type="date"
                      className="issue-date-input"
                      value={dueDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => {
                        setDueDate(e.target.value);
                        setFieldError((f) => ({ ...f, dueDate: '' }));
                      }}
                    />
                  </span>
                  {fieldError.dueDate && <span className="field-error">{fieldError.dueDate}</span>}
                </label>
              </div>
            )}
          </section>

          <section className="issue-block" aria-labelledby={`${formId}-q5`}>
            <header className="issue-block-head">
              <span className="issue-step is-optional">5</span>
              <div>
                <h2 id={`${formId}-q5`}>
                  截图或示例 <span className="issue-optional-tag">可选</span>
                </h2>
                <p>可上传界面截图、流程图或脱敏后的输入输出样例。请勿上传敏感信息。</p>
              </div>
            </header>
            <div className="issue-media">
              {previews.map((item, index) => (
                <figure key={`${item.file.name}-${item.file.size}-${index}`} className="issue-thumb">
                  <img src={item.url} alt={item.file.name} />
                  <figcaption>
                    <span title={item.file.name}>{item.file.name}</span>
                    <em>{formatSize(item.file.size)}</em>
                  </figcaption>
                  <button
                    type="button"
                    className="issue-thumb-remove"
                    aria-label={`移除 ${item.file.name}`}
                    onClick={() => removeFile(index)}
                  >
                    ×
                  </button>
                </figure>
              ))}
              {files.length < MAX_FILES && (
                <label className={`issue-upload ${files.length === 0 ? 'is-empty' : ''}`}>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    multiple
                    onChange={(e) => {
                      onPickFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <span className="issue-upload-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 16V8m0 0l-3 3m3-3l3 3M5 16.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <strong>{files.length === 0 ? '点击或拖拽上传截图' : '继续添加'}</strong>
                  <span>JPG / PNG / GIF / WebP · 单张 ≤ 5MB</span>
                </label>
              )}
            </div>
            <p className="hint issue-media-hint">
              最多 {MAX_FILES} 张。请勿上传含账号、客户隐私等敏感信息的截图。
            </p>
          </section>

          <section className="issue-block issue-block-compact" aria-labelledby={`${formId}-project`}>
            <header className="issue-block-head">
              <span className="issue-step">6</span>
              <div>
                <h2 id={`${formId}-project`}>
                  关联项目<em>*</em>
                </h2>
                <p>用于后续看板分派；默认选中当前可用项目。</p>
              </div>
            </header>
            <label className={`issue-field issue-field-select ${fieldError.projectId ? 'is-invalid' : ''}`}>
              <span className="issue-select-wrap">
                <select
                  className="issue-select"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setFieldError((f) => ({ ...f, projectId: '' }));
                  }}
                  disabled={projects.length === 0}
                >
                  {projects.length === 0 ? (
                    <option value="">暂无可用项目</option>
                  ) : (
                    projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  )}
                </select>
              </span>
              {fieldError.projectId && <span className="field-error">{fieldError.projectId}</span>}
            </label>
            <div className="issue-inline-create-project">
              <p className="hint">没有合适的项目？可直接新建：</p>
              <div className="issue-inline-create-row">
                <input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  maxLength={128}
                  placeholder="新项目名称"
                  aria-label="新项目名称"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={creatingProject || !newProjectName.trim()}
                  onClick={(e) => void onCreateProject(e)}
                >
                  {creatingProject ? '创建中...' : '新建项目'}
                </button>
              </div>
            </div>
          </section>

          <label className={`issue-field ${fieldError.title ? 'is-invalid' : ''}`}>
            <span className="issue-field-label">需求标题</span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setFieldError((f) => ({ ...f, title: '' }));
              }}
              maxLength={200}
              placeholder="可手动填写，或点击下方按钮根据问题描述生成"
            />
            {fieldError.title && <span className="field-error">{fieldError.title}</span>}
          </label>

          <aside className="issue-ai-banner">
            <div>
              <strong>提交前检查一下</strong>
              <p>检查必填信息是否完整，并根据问题描述生成标题；不会自动提交。</p>
              {checkHint && <p className="issue-ai-hint">{checkHint}</p>}
            </div>
            <button type="button" className="btn-secondary" onClick={onTitleCheck}>
              检查并生成标题
            </button>
          </aside>

          {error && <p className="error-text">{error}</p>}

          <footer className="issue-footer">
            <p className="hint">
              {isExecutor
                ? `提交后，你可自行评定优先级并推进进度，完成后可自行验收；也可由${executorLabel}其他成员处理。`
                : `提交后，${executorLabel}会完成分类、优先级和可行性评估。`}
            </p>
            <button
              type="submit"
              className="btn-primary issue-submit"
              disabled={submitting || loading || projects.length === 0}
            >
              {submitting ? '提交中...' : '提交问题 →'}
            </button>
          </footer>
          </form>

          <aside className="submit-tips" aria-label="怎么填写问题">
            <div className="submit-tips-inner">
              <p className="submit-tips-eyebrow">填写提示</p>
              <h2>怎么写清楚问题</h2>
              <p className="submit-tips-formula">
                按左侧步骤写：问题是什么、希望变成什么样、影响有多大。写得越具体，
                {isExecutor ? '越容易自行判断优先级。' : `${executorLabel}越容易判断优先级。`}
              </p>
              <ol className="submit-tips-steps">
                {TIP_STEPS.map((step, index) => (
                  <li key={step.label}>
                    <span className="submit-tips-index">{index + 1}</span>
                    <div>
                      <strong>{step.label}</strong>
                      <span>{step.hint}</span>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="submit-tips-example">
                <strong>示例</strong>
                <p>
                  每次客户会议后，我要听录音整理纪要再手动录入 CRM。每天约 5 次、每次约 30
                  分钟，还容易漏掉关键诉求。希望会议结束后几分钟内生成可确认的纪要并自动提取下一步行动。
                </p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

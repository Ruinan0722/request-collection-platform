export type Priority = 'unset' | 'p0' | 'p1' | 'p2' | 'p3';
export type ReqStatus =
  | 'evaluating'
  | 'waiting_impl'
  | 'implementing'
  | 'pending_accept'
  | 'done'
  | 'wont_impl'
  | 'backlog' // 历史别名 → evaluating
  | 'todo'
  | 'doing';

export interface ProgressNode {
  code: ReqStatus | string;
  label: string;
  state: 'done' | 'current' | 'pending';
  enteredAt?: string | null;
  leftAt?: string | null;
  durationMinutes?: number | null;
  durationLabel?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  requirementCount: number;
  createdAt?: string | null;
}

export interface RequirementAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  createdAt?: string | null;
}

export interface Requirement {
  id: string;
  projectId: string;
  projectName?: string | null;
  title: string;
  description?: string | null;
  afterImpl?: string | null;
  implValue?: string | null;
  efficiencyGain?: string | null;
  expectedLevel?: Priority;
  priority: Priority;
  status: ReqStatus;
  statusLabel?: string | null;
  progressNodes?: ProgressNode[];
  requesterId: string;
  requesterName?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  prioritySetBy?: string | null;
  priorityNote?: string | null;
  wontReason?: string | null;
  dueDate?: string | null;
  claimedAt?: string | null;
  attachments?: RequirementAttachment[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  unset: '未评定',
  p0: 'P0 紧急',
  p1: 'P1 高',
  p2: 'P2 中',
  p3: 'P3 低',
};

export const EXPECTED_LEVEL_LABEL: Record<Priority, string> = {
  unset: '未选择',
  p0: 'P0 紧急',
  p1: 'P1 高',
  p2: 'P2 中',
  p3: 'P3 低',
};

export const STATUS_LABEL: Record<string, string> = {
  evaluating: '待评优先级',
  waiting_impl: '等待实现',
  implementing: '实现中',
  pending_accept: '已实现等待验收',
  done: '已验收完成',
  wont_impl: '无法实现',
  backlog: '待评优先级',
  todo: '等待实现',
  doing: '实现中',
};

export const PROGRESS_ORDER: Array<{ code: ReqStatus; label: string }> = [
  { code: 'evaluating', label: '待评优先级' },
  { code: 'waiting_impl', label: '等待实现' },
  { code: 'implementing', label: '实现中' },
  { code: 'pending_accept', label: '已实现等待验收' },
  { code: 'done', label: '已验收完成' },
  { code: 'wont_impl', label: '无法实现' },
];

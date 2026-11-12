import { defaultExecutorOrgLabel } from './auth/executorOrgs';

export type UserRole = 'requester' | 'executor';
export type Priority = 'unset' | 'p0' | 'p1' | 'p2' | 'p3';
export type ReqStatus = 'backlog' | 'evaluating' | 'todo' | 'doing' | 'done';

export interface User {
  id: string;
  name: string;
  role: UserRole;
  avatarUrl?: string | null;
  email?: string | null;
  departmentIds?: string[];
  departmentNames?: string[];
  roleSource?: string;
  roleLocked?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  ownerId: string;
  requirementCount: number;
  createdAt?: string | null;
}

export interface Requirement {
  id: string;
  projectId: string;
  projectName?: string | null;
  title: string;
  description?: string | null;
  priority: Priority;
  status: ReqStatus;
  requesterId: string;
  requesterName?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  prioritySetBy?: string | null;
  priorityNote?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export const ROLE_LABEL: Record<UserRole, string> = {
  requester: '需求方',
  executor: defaultExecutorOrgLabel(),
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  unset: '未评定',
  p0: 'P0 紧急',
  p1: 'P1 高',
  p2: 'P2 中',
  p3: 'P3 低',
};

export const STATUS_LABEL: Record<ReqStatus, string> = {
  backlog: '待评优先级',
  evaluating: '待评优先级',
  todo: '待开发',
  doing: '进行中',
  done: '已完成',
};

/** @deprecated 使用 canCreateRequirement；保留兼容 */
export function canRequest(role: UserRole): boolean {
  return role === 'requester' || role === 'executor';
}

export function canExecute(role: UserRole): boolean {
  return role === 'executor';
}

import type { UserRole } from './AuthContext';

/**
 * 平台能力判定（与角色解耦，便于执行方自提 / 自验）。
 * 执行方组织扩展见 executorOrgs.ts，勿在此写死部门名。
 */

/** 任一登录角色均可提需求（含执行方自提）。 */
export function canCreateRequirement(role: UserRole | null | undefined): boolean {
  return role === 'requester' || role === 'executor';
}

/** 仅提需人可验收完成（须处于「已实现等待验收」；执行方不可代验）。 */
export function canAcceptRequirement(opts: {
  status: string | null | undefined;
  requesterId: string | null | undefined;
  userId: string | null | undefined;
}): boolean {
  return (
    !!opts.userId &&
    !!opts.requesterId &&
    opts.userId === opts.requesterId &&
    opts.status === 'pending_accept'
  );
}

/** 执行方：评优先级、推进进度。 */
export function canExecuteWork(role: UserRole | null | undefined): boolean {
  return role === 'executor';
}

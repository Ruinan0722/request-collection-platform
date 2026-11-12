/**
 * 执行方组织（处理团队）注册表 —— 与后端 executor_orgs 对齐。
 *
 * 当前仅「AI效能部」。后续多执行方时扩展 EXECUTOR_ORGS，
 * 勿在导航 / 表单中直接做组织选择器，除非产品明确开放。
 */

export type ExecutorOrgCode = 'ai_efficiency' | (string & {});

export interface ExecutorOrg {
  code: ExecutorOrgCode;
  /** 对外展示名（列表「处理方」、导航身份文案等） */
  displayName: string;
  departmentNameAliases: string[];
}

/** 静态目录：新增执行方组织时在此追加，勿散落硬编码「AI效能部」字符串。 */
export const EXECUTOR_ORGS: readonly ExecutorOrg[] = [
  {
    code: 'ai_efficiency',
    displayName: 'AI效能部',
    departmentNameAliases: ['AI效能', 'AI效能部'],
  },
] as const;

export function defaultExecutorOrg(): ExecutorOrg {
  return EXECUTOR_ORGS[0];
}

/** 当前默认执行方展示名（UI 文案用；多组织选择器未开放）。 */
export function defaultExecutorOrgLabel(): string {
  return defaultExecutorOrg().displayName;
}

/**
 * 按用户部门解析所属执行方组织；非执行方返回 null。
 * 未命中具体组织时回落到默认组织。
 */
export function resolveExecutorOrg(input: {
  role?: string | null;
  departmentNames?: string[] | null;
}): ExecutorOrg | null {
  if (input.role !== 'executor') return null;
  const names = (input.departmentNames || []).map((n) => n.trim()).filter(Boolean);
  for (const org of EXECUTOR_ORGS) {
    if (
      names.some((n) =>
        org.departmentNameAliases.some((a) => n === a || n.includes(a) || a.includes(n)),
      )
    ) {
      return org;
    }
  }
  return defaultExecutorOrg();
}

export function executorOrgDisplayName(input: {
  role?: string | null;
  departmentNames?: string[] | null;
  assigneeId?: string | null;
}): string | null {
  if (!input.assigneeId) return null;
  const org = resolveExecutorOrg(input);
  return org?.displayName ?? defaultExecutorOrgLabel();
}

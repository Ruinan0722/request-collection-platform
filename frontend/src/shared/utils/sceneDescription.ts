export type SceneDescription = {
  department?: string;
  role?: string;
  who?: string;
  action?: string;
  when?: string;
  pain?: string;
  frequency?: string;
  reach?: string;
  impact?: string;
  milestone?: string;
  submitMode?: string;
  extra?: string;
  /** 无法按新版结构解析时的原文 */
  raw?: string;
  structured: boolean;
};

const FIELD_MAP: Array<{ key: keyof Omit<SceneDescription, 'raw' | 'structured'>; label: string }> = [
  { key: 'department', label: '部门' },
  { key: 'role', label: '岗位' },
  { key: 'who', label: '相关人员' },
  { key: 'action', label: '业务场景' },
  { key: 'when', label: '触发时机' },
  { key: 'pain', label: '问题描述' },
  { key: 'frequency', label: '发生频率' },
  { key: 'reach', label: '影响人数' },
  { key: 'impact', label: '当前影响' },
  { key: 'milestone', label: '业务节点' },
  { key: 'submitMode', label: '提交方式' },
  { key: 'extra', label: '补充说明' },
];

/** 取标记后到下一【字段】或文末的内容，支持多行。 */
function extractField(text: string, label: string): string | undefined {
  const re = new RegExp(`【${label}】\\s*([\\s\\S]*?)(?=\\n【[^】]+】|$)`);
  const m = text.match(re);
  if (!m) return undefined;
  const value = m[1].trim();
  return value || undefined;
}

/** 解析提需求表单写入的结构化 description；旧自由文本则原样返回。 */
export function parseSceneDescription(description?: string | null): SceneDescription {
  const text = (description || '').trim();
  if (!text) {
    return { structured: false, raw: '' };
  }

  const result: SceneDescription = { structured: false };
  let matched = 0;

  for (const { key, label } of FIELD_MAP) {
    const value = extractField(text, label);
    if (value) {
      result[key] = value;
      matched += 1;
    }
  }

  const hasLegacyScene = Boolean(result.action || result.role || result.when);
  const hasIssueForm = Boolean(result.pain && (result.frequency || result.reach || result.impact));

  if (matched >= 2 && (hasLegacyScene || hasIssueForm)) {
    result.structured = true;
    return result;
  }

  return { structured: false, raw: text };
}

export const SCENE_DETAIL_FIELDS: Array<{
  key: keyof Omit<SceneDescription, 'raw' | 'structured'>;
  label: string;
}> = [
  { key: 'department', label: '部门' },
  { key: 'who', label: '相关人员' },
  { key: 'pain', label: '问题描述' },
  { key: 'frequency', label: '发生频率' },
  { key: 'reach', label: '影响人数' },
  { key: 'impact', label: '当前影响' },
  { key: 'milestone', label: '业务节点' },
  { key: 'role', label: '岗位' },
  { key: 'when', label: '触发时机' },
  { key: 'action', label: '业务场景' },
  { key: 'submitMode', label: '提交方式' },
  { key: 'extra', label: '补充说明' },
];

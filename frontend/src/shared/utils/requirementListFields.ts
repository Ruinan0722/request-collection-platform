import type { Priority, Requirement } from '@shared/types/domain';
import { EXPECTED_LEVEL_LABEL } from '@shared/types/domain';
import { parseSceneDescription } from '@shared/utils/sceneDescription';

export type RequirementListFields = {
  frequency: string;
  reach: string;
  impact: string;
  afterImpl: string;
  milestone: string;
  expectedLevel: Priority;
  expectedLevelLabel: string;
};

function truncate(text: string, max = 48) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '-';
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/** 从需求记录提取列表展示用字段（兼容新旧描述结构）。 */
export function getRequirementListFields(item: Requirement): RequirementListFields {
  const scene = parseSceneDescription(item.description);
  const frequency =
    scene.frequency ||
    (item.efficiencyGain || '').replace(/^发生频率：/, '').trim() ||
    '-';
  const reach = scene.reach || '-';
  let impact = scene.impact || '-';
  if (impact === '-' && item.implValue) {
    const m = item.implValue.match(/当前影响：(.+)$/);
    if (m) impact = m[1].trim();
  }
  const afterImpl = truncate(item.afterImpl || '');
  const milestone = item.dueDate
    ? item.dueDate.slice(0, 10)
    : scene.milestone?.includes('没有')
      ? '无明确节点'
      : scene.milestone || '无明确节点';
  const expectedLevel = (item.expectedLevel || 'unset') as Priority;

  return {
    frequency,
    reach,
    impact,
    afterImpl,
    milestone,
    expectedLevel,
    expectedLevelLabel: EXPECTED_LEVEL_LABEL[expectedLevel],
  };
}

from __future__ import annotations

from typing import List, Optional, Tuple

from app.config.settings import settings

# (department_name, role_code) role_code: requester | executor
DepartmentRule = Tuple[str, str]


def _parse_env_list(raw: str) -> List[str]:
    return [s.strip() for s in (raw or "").split(",") if s.strip()]


def env_department_rules() -> List[DepartmentRule]:
    rules: List[DepartmentRule] = []
    for name in _parse_env_list(settings.feishu_requester_departments):
        rules.append((name, "requester"))
    for name in _parse_env_list(settings.feishu_executor_departments):
        rules.append((name, "executor"))
    return rules


def department_matches(user_departments: List[str], configured: List[str]) -> bool:
    normalized = [d.strip() for d in user_departments if d and d.strip()]
    return any(
        dept == cfg or dept in cfg or cfg in dept
        for dept in normalized
        for cfg in configured
        if cfg
    )


def is_admin_open_id(feishu_open_id: str) -> bool:
    """仅用于管理操作（如组织同步），不参与业务身份判定。"""
    return feishu_open_id in settings.admin_open_id_list


def _hit_executor(
    department_names: List[str],
    department_ids: Optional[List[str]],
    executor_tree_ids: Optional[set],
) -> bool:
    for dept_name, role_code in env_department_rules():
        if role_code != "executor":
            continue
        if department_matches(department_names, [dept_name]):
            return True
    ids = set(department_ids or [])
    if executor_tree_ids and ids.intersection(executor_tree_ids):
        return True
    # 配置的 AI效能部 部门 ID 直接命中（无需依赖树扩展）
    configured = set(settings.executor_department_id_list)
    if configured and ids.intersection(configured):
        return True
    return False


def resolve_platform_role(
    *,
    feishu_open_id: str,
    department_names: List[str],
    department_ids: Optional[List[str]] = None,
    requester_tree_ids: Optional[set] = None,
    executor_tree_ids: Optional[set] = None,
) -> str:
    """
    根据部门解析平台身份（仅两种：requester | executor）：
    - 命中个人执行方 open_id 白名单 → executor
    - 命中执行方部门配置（当前为「AI效能」等，见 settings / executor_orgs）→ executor
    - 其余一律 → requester

    执行方可自提需求并自行验收；「属于哪个执行方组织」的展示名见 executor_orgs。
    """
    _ = requester_tree_ids

    if feishu_open_id in settings.executor_open_id_list:
        return "executor"

    if _hit_executor(department_names, department_ids, executor_tree_ids):
        return "executor"

    return "requester"

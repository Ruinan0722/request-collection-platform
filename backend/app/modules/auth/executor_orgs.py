"""执行方组织（处理团队）注册表。

当前生产仅「AI效能部」一个执行方组织。
后续若增加其他执行方部门：
1. 在 settings 的 FEISHU_EXECUTOR_DEPARTMENTS / FEISHU_EXECUTOR_DEPARTMENT_IDS 追加配置；
2. 在 `_STATIC_ORGS` 追加对应 ExecutorOrg（或改为完全由配置驱动）；
3. 前端展示名走 `executor_org_display_name`，暂勿做多组织选择器 UI。

需求方 / 执行方是平台角色（User.role）；执行方组织是「谁在处理」的展示归属。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from app.config.settings import settings
from app.modules.auth.models import User
from app.modules.auth.role_resolver import department_matches


@dataclass(frozen=True)
class ExecutorOrg:
    """一个执行方组织：稳定 code + 对外展示名 + 部门匹配规则。"""

    code: str
    display_name: str
    # 与 User.department_names 模糊匹配（含子串）
    department_name_aliases: Tuple[str, ...]
    # 与 User.department_ids 精确匹配；空则仅用名称 / 全局 executor id 配置
    department_ids: Tuple[str, ...] = ()


# 静态目录：目前仅 AI效能部。新增执行方时在此追加，勿直接改业务硬编码文案。
_STATIC_ORGS: Tuple[ExecutorOrg, ...] = (
    ExecutorOrg(
        code="ai_efficiency",
        display_name="AI效能部",
        department_name_aliases=("AI效能", "AI效能部"),
    ),
)


def configured_executor_orgs() -> List[ExecutorOrg]:
    """合并静态目录与环境变量中的执行方部门（同名合并，新名按展示名生成条目）。"""
    by_code = {org.code: org for org in _STATIC_ORGS}
    env_names = [s.strip() for s in (settings.feishu_executor_departments or "").split(",") if s.strip()]
    env_ids = tuple(settings.executor_department_id_list)

    # 将全局 executor department ids 挂到默认（首个）组织，便于 ID 命中
    if env_ids and "ai_efficiency" in by_code:
        base = by_code["ai_efficiency"]
        by_code["ai_efficiency"] = ExecutorOrg(
            code=base.code,
            display_name=base.display_name,
            department_name_aliases=base.department_name_aliases,
            department_ids=tuple(dict.fromkeys(base.department_ids + env_ids)),
        )

    for name in env_names:
        matched = next(
            (
                org
                for org in by_code.values()
                if name in org.department_name_aliases or name == org.display_name
            ),
            None,
        )
        if matched:
            continue
        # 预留：配置了新的执行方部门名但尚未录入静态目录时，自动生成条目
        code = f"executor_{len(by_code) + 1}"
        by_code[code] = ExecutorOrg(
            code=code,
            display_name=name,
            department_name_aliases=(name,),
        )

    # 保持静态顺序，其后为自动生成的
    ordered: List[ExecutorOrg] = []
    seen = set()
    for org in _STATIC_ORGS:
        current = by_code[org.code]
        ordered.append(current)
        seen.add(current.code)
    for code, org in by_code.items():
        if code not in seen:
            ordered.append(org)
    return ordered


def default_executor_org() -> ExecutorOrg:
    orgs = configured_executor_orgs()
    return orgs[0]


def resolve_executor_org_for_user(user: Optional[User]) -> Optional[ExecutorOrg]:
    """按用户部门解析所属执行方组织；非执行方或无法匹配时返回 None。"""
    if not user or user.role != "executor":
        return None
    names = [str(n) for n in (user.department_names or []) if n]
    ids = {str(i) for i in (user.department_ids or []) if i}
    for org in configured_executor_orgs():
        if org.department_ids and ids.intersection(org.department_ids):
            return org
        if department_matches(names, list(org.department_name_aliases)):
            return org
    # 已是执行方但部门未命中具体组织 → 回落到默认组织（当前即 AI效能部）
    return default_executor_org()


def executor_org_display_name(
    user: Optional[User] = None,
    *,
    fallback: Optional[str] = None,
) -> str:
    """处理方对外展示名（列表/详情「处理方」列）。"""
    org = resolve_executor_org_for_user(user) if user else None
    if org:
        return org.display_name
    return fallback or default_executor_org().display_name


def list_executor_org_labels() -> Sequence[str]:
    """供后续 API / 管理端使用；前端暂不展示多组织选择。"""
    return [org.display_name for org in configured_executor_orgs()]

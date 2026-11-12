from __future__ import annotations

from typing import Any, Dict, List, Set

from sqlalchemy.orm import Session

from app.config.settings import settings
from app.modules.auth.contact import (
    collect_department_tree_ids,
    list_department_member_open_ids,
    load_department_records,
    resolve_user_org_profile,
)
from app.modules.auth.department_labels import resolve_department_name
from app.modules.auth.models import FeishuDepartment, User
from app.modules.auth.role_resolver import resolve_platform_role
from app.shared.logger import get_logger

log = get_logger(module="org-sync")


def _department_display_name(dept_id: str, item: Dict[str, Any]) -> str:
    """飞书常因缺 contact:department.base:readonly 不回 name，优先 API，再走本地 labels。"""
    api_name = (item.get("name") or "").strip()
    if api_name:
        return api_name
    i18n = item.get("i18n_name") or {}
    if isinstance(i18n, dict):
        for key in ("zh_cn", "ja_jp", "en_us"):
            val = (i18n.get(key) or "").strip()
            if val:
                return val
    return (resolve_department_name(dept_id) or "").strip()


def _upsert_departments(db: Session, records: Dict[str, Dict[str, Any]]) -> int:
    count = 0
    for dept_id, item in records.items():
        row = db.get(FeishuDepartment, dept_id)
        name = _department_display_name(dept_id, item)
        parent = item.get("parent_department_id")
        if row:
            row.name = name or row.name
            row.parent_department_id = parent
            row.raw = item
        else:
            db.add(
                FeishuDepartment(
                    open_department_id=dept_id,
                    name=name,
                    parent_department_id=parent,
                    raw=item,
                )
            )
        count += 1
    return count


def get_role_tree_id_sets(db: Session, *, live_expand: bool = False) -> Dict[str, Set[str]]:
    """构建提需/执行部门 ID 集合。

    登录路径默认不实时打飞书（只读配置 + 本地库），避免回调卡住十几秒。
    组织同步时可 live_expand=True 拉全量子树。
    """
    requester_roots = settings.requester_department_id_list
    executor_roots = settings.executor_department_id_list

    def expand(roots: List[str]) -> Set[str]:
        out: Set[str] = set()
        for root in roots:
            local_ids = {root}
            frontier = [root]
            while frontier:
                pid = frontier.pop()
                children = (
                    db.query(FeishuDepartment)
                    .filter(FeishuDepartment.parent_department_id == pid)
                    .all()
                )
                for child in children:
                    if child.open_department_id not in local_ids:
                        local_ids.add(child.open_department_id)
                        frontier.append(child.open_department_id)
            if live_expand and len(local_ids) == 1:
                try:
                    local_ids.update(collect_department_tree_ids(root))
                except Exception as exc:
                    log.warn("实时扩展部门树失败", root=root, error=str(exc))
            out.update(local_ids)
        return out

    requester = expand(requester_roots)
    executor = expand(executor_roots)
    executor = executor - requester
    return {"requester": requester, "executor": executor}


def apply_org_profile_to_user(db: Session, user: User, profile: Dict[str, Any]) -> User:
    trees = get_role_tree_id_sets(db)
    department_ids = profile.get("department_ids") or []
    department_names = profile.get("department_names") or []

    user.department_ids = department_ids
    user.department_names = department_names
    if profile.get("name"):
        user.name = profile["name"]
    if profile.get("avatar_url"):
        user.avatar_url = profile["avatar_url"]
    if profile.get("email"):
        user.email = profile["email"]

    if not user.role_locked:
        try:
            role = resolve_platform_role(
                feishu_open_id=user.feishu_open_id or "",
                department_names=department_names,
                department_ids=department_ids,
                requester_tree_ids=trees["requester"],
                executor_tree_ids=trees["executor"],
            )
            user.role = role
            user.role_source = "feishu"
        except RuntimeError:
            if settings.feishu_skip_department_check:
                user.role = user.role or "requester"
                user.role_source = "feishu"
            else:
                raise

    records = profile.get("department_records") or {}
    if records:
        _upsert_departments(db, records)

    return user


def sync_org_from_roots(db: Session) -> Dict[str, Any]:
    """按配置根部门同步部门树与成员画像（精简版，对齐 7月6日思路）。"""
    roots = settings.org_root_department_id_list
    if not roots:
        return {"ok": False, "message": "未配置 FEISHU_ORG_ROOT_DEPARTMENT_IDS", "departments": 0, "users": 0}

    all_dept_ids: Set[str] = set()
    for root in roots:
        try:
            all_dept_ids.update(collect_department_tree_ids(root))
        except Exception as exc:
            log.error("同步部门树失败", exc, root=root)

    records = load_department_records(list(all_dept_ids))
    dept_count = _upsert_departments(db, records)

    open_ids: Set[str] = set()
    for dept_id in all_dept_ids:
        try:
            open_ids.update(list_department_member_open_ids(dept_id))
        except Exception as exc:
            log.warn("拉取部门成员失败", department_id=dept_id, error=str(exc))

    user_count = 0
    for open_id in sorted(open_ids):
        try:
            # 默认不逐人拉部门详情（飞书常无 name）；名称靠 labels 兜底，避免同步过慢
            profile = resolve_user_org_profile(open_id)
            user = db.query(User).filter(User.feishu_open_id == open_id).one_or_none()
            if not user:
                from uuid import uuid4

                user = User(
                    id=str(uuid4()),
                    feishu_open_id=open_id,
                    name=profile.get("name") or "飞书用户",
                    role="requester",
                    role_source="feishu",
                )
                db.add(user)
            apply_org_profile_to_user(db, user, profile)
            user_count += 1
        except Exception as exc:
            log.warn("同步用户失败", open_id=open_id, error=str(exc))

    db.commit()
    log.info("组织同步完成", departments=dept_count, users=user_count, roots=len(roots))
    return {"ok": True, "departments": dept_count, "users": user_count, "roots": roots}

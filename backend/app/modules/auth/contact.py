from __future__ import annotations

from typing import Any, Dict, List, Optional, Set

from app.modules.auth.department_labels import resolve_department_name
from app.modules.auth.feishu_client import feishu_get
from app.shared.logger import get_logger

log = get_logger(module="feishu-contact")


def fetch_feishu_user_detail(open_id: str) -> Dict[str, Any]:
    data = feishu_get(
        "/contact/v3/users/{0}".format(open_id),
        params={"user_id_type": "open_id", "department_id_type": "open_department_id"},
    )
    user = data.get("user")
    if not user:
        raise RuntimeError("飞书未返回用户信息")
    return user


def _fetch_departments_batch(department_ids: List[str]) -> List[Dict[str, Any]]:
    if not department_ids:
        return []
    qs = "&".join("department_ids={0}".format(did) for did in department_ids)
    path = (
        "/contact/v3/departments/batch?"
        "department_id_type=open_department_id&user_id_type=open_id&{0}".format(qs)
    )
    data = feishu_get(path)
    return data.get("items") or []


def load_department_records(department_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """批量拉取部门信息，并向上补齐父部门。"""
    cache: Dict[str, Dict[str, Any]] = {}
    pending: Set[str] = {d for d in department_ids if d}
    while pending:
        chunk = list(pending)[:50]
        pending -= set(chunk)
        try:
            for item in _fetch_departments_batch(chunk):
                dept_id = item.get("open_department_id") or item.get("department_id")
                if dept_id:
                    cache[str(dept_id)] = item
        except Exception as exc:
            log.warn("批量拉取部门失败，继续", error=str(exc), chunk_size=len(chunk))
            continue
        for dept_id in chunk:
            parent = (cache.get(dept_id) or {}).get("parent_department_id")
            if parent and parent not in ("0", "") and parent not in cache:
                pending.add(str(parent))
    return cache


def list_child_department_ids(parent_id: str) -> List[str]:
    page_token: Optional[str] = None
    children: List[str] = []
    while True:
        params: Dict[str, Any] = {
            "department_id_type": "open_department_id",
            "page_size": 50,
            "fetch_child": False,
        }
        if page_token:
            params["page_token"] = page_token
        data = feishu_get("/contact/v3/departments/{0}/children".format(parent_id), params=params)
        for item in data.get("items") or []:
            cid = item.get("open_department_id") or item.get("department_id")
            if cid:
                children.append(str(cid))
        if not data.get("has_more"):
            break
        page_token = data.get("page_token")
        if not page_token:
            break
    return children


def collect_department_tree_ids(root_id: str) -> List[str]:
    """BFS 拉取某根部门下全部子部门 ID（含自身）。"""
    ids = {root_id}
    frontier = [root_id]
    while frontier:
        next_frontier: List[str] = []
        for pid in frontier:
            try:
                for cid in list_child_department_ids(pid):
                    if cid not in ids:
                        ids.add(cid)
                        next_frontier.append(cid)
            except Exception as exc:
                log.warn("拉取子部门失败", parent=pid, error=str(exc))
        frontier = next_frontier
    return list(ids)


def list_department_member_open_ids(department_id: str) -> List[str]:
    page_token: Optional[str] = None
    open_ids: List[str] = []
    while True:
        params: Dict[str, Any] = {
            "department_id": department_id,
            "department_id_type": "open_department_id",
            "user_id_type": "open_id",
            "page_size": 50,
        }
        if page_token:
            params["page_token"] = page_token
        data = feishu_get("/contact/v3/users/find_by_department", params=params)
        for item in data.get("items") or []:
            oid = item.get("open_id") or (item.get("user") or {}).get("open_id")
            if oid:
                open_ids.append(str(oid))
        if not data.get("has_more"):
            break
        page_token = data.get("page_token")
        if not page_token:
            break
    return open_ids


def resolve_user_org_profile(open_id: str, *, fetch_dept_details: bool = False) -> Dict[str, Any]:
    """解析用户组织画像：部门 ID / 名称。

    默认用本地 labels 解析部门名，避免登录时批量/向上查询飞书部门接口过慢。
    """
    user = fetch_feishu_user_detail(open_id)
    department_ids = [d for d in (user.get("department_ids") or []) if isinstance(d, str) and d]

    cache: Dict[str, Dict[str, Any]] = {}
    if fetch_dept_details:
        cache = load_department_records(department_ids)

    department_names: List[str] = []
    for dept_id in department_ids:
        record = cache.get(dept_id) or {}
        name = (record.get("name") or "").strip() or (resolve_department_name(dept_id) or "")
        if name and name not in department_names:
            department_names.append(name)
        if name and dept_id in cache and not (cache[dept_id].get("name") or "").strip():
            cache[dept_id] = {**cache[dept_id], "name": name}

    return {
        "open_id": open_id,
        "name": user.get("name") or user.get("en_name") or "飞书用户",
        "avatar_url": (user.get("avatar") or {}).get("avatar_origin")
        or (user.get("avatar") or {}).get("avatar_72")
        or user.get("avatar_url"),
        "email": user.get("email"),
        "department_ids": department_ids,
        "department_names": department_names,
        "department_records": cache,
        "is_active": not bool(user.get("status", {}).get("is_resigned")),
    }

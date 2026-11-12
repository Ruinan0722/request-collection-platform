"""飞书机器人通知：新建需求 / 进入验收 / 验收完成。

失败只记日志，不影响业务写入。
"""

from __future__ import annotations

import json
from typing import Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config.settings import settings
from app.modules.auth.feishu_client import feishu_post
from app.modules.auth.models import User
from app.modules.projects.models import Project
from app.modules.requirements.models import Requirement
from app.modules.requirements.progress import STATUS_LABEL, normalize_status
from app.shared.database import SessionLocal
from app.shared.logger import get_logger

log = get_logger(module="feishu-notify")

PRIORITY_LABEL: Dict[str, str] = {
    "unset": "未评定",
    "p0": "P0 紧急",
    "p1": "P1 高",
    "p2": "P2 中",
    "p3": "P3 低",
}


def _is_sendable_open_id(open_id: Optional[str]) -> bool:
    if not open_id or not str(open_id).strip():
        return False
    oid = str(open_id).strip()
    if oid.startswith("dev:"):
        return False
    return True


def _dedupe_open_ids(open_ids: Sequence[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for raw in open_ids:
        oid = (raw or "").strip()
        if not _is_sendable_open_id(oid) or oid in seen:
            continue
        seen.add(oid)
        out.append(oid)
    return out


def resolve_owner_open_ids(db: Session, req: Requirement) -> List[str]:
    """新建 / 验收完成：按 FEISHU_NOTIFY_OWNER_MODE 解析收件人。"""
    mode = (settings.feishu_notify_owner_mode or "open_ids").strip().lower()
    configured = _dedupe_open_ids(settings.notify_owner_open_id_list)

    if mode == "assignees":
        ids: List[str] = []
        if req.assignee_id:
            user = db.get(User, req.assignee_id)
            if user and _is_sendable_open_id(user.feishu_open_id):
                ids.append(str(user.feishu_open_id))
        if not ids:
            return configured
        return _dedupe_open_ids(ids)

    if mode == "executors":
        rows = db.scalars(select(User).where(User.role == "executor")).all()
        ids = [str(u.feishu_open_id) for u in rows if _is_sendable_open_id(u.feishu_open_id)]
        if not ids:
            return configured
        return _dedupe_open_ids(ids)

    return configured


def _detail_url(requirement_id: str) -> str:
    base = settings.public_app_base_url
    if not base:
        return ""
    return "{0}/requirements/{1}".format(base, requirement_id)


def _build_card(
    *,
    title: str,
    template: str,
    fields: List[tuple[str, str]],
    detail_url: str,
) -> dict:
    elements: List[dict] = [
        {
            "tag": "div",
            "fields": [
                {
                    "is_short": True,
                    "text": {
                        "tag": "lark_md",
                        "content": "**{0}**\n{1}".format(label, value or "—"),
                    },
                }
                for label, value in fields
            ],
        }
    ]
    if detail_url:
        elements.append(
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "查看详情"},
                        "type": "primary",
                        "url": detail_url,
                    }
                ],
            }
        )
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": template,
            "title": {"tag": "plain_text", "content": title},
        },
        "elements": elements,
    }


def _send_card(receive_open_id: str, card: dict) -> None:
    feishu_post(
        "/im/v1/messages",
        params={"receive_id_type": "open_id"},
        body={
            "receive_id": receive_open_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        },
        timeout=12.0,
    )


def _send_to_many(open_ids: Sequence[str], card: dict, *, event: str, requirement_id: str) -> None:
    failed = 0
    for oid in open_ids:
        try:
            _send_card(oid, card)
            log.info("飞书通知已发送", event=event, requirement_id=requirement_id, open_id=oid)
        except Exception as exc:
            failed += 1
            log.error(
                "飞书通知发送失败",
                exc,
                event=event,
                requirement_id=requirement_id,
                open_id=oid,
            )
    if failed:
        # 汇总一条便于告警聚合：批量发送出现失败时能快速发现
        log.error(
            "飞书通知批量发送失败",
            event=event,
            requirement_id=requirement_id,
            failed=failed,
            total=len(open_ids),
        )


def _load_context(db: Session, requirement_id: str) -> Optional[tuple[Requirement, Optional[Project], Dict[str, User]]]:
    req = db.get(Requirement, requirement_id)
    if not req:
        log.warning("飞书通知跳过：需求不存在", requirement_id=requirement_id)
        return None
    project = db.get(Project, req.project_id) if req.project_id else None
    user_ids = [uid for uid in (req.requester_id, req.assignee_id) if uid]
    users: Dict[str, User] = {}
    if user_ids:
        rows = db.scalars(select(User).where(User.id.in_(user_ids))).all()
        users = {u.id: u for u in rows}
    return req, project, users


def _user_name(users: Dict[str, User], user_id: Optional[str]) -> str:
    if not user_id:
        return "—"
    user = users.get(user_id)
    return (user.name if user else None) or "—"


def notify_requirement_created(requirement_id: str) -> None:
    """新建需求 → 负责人（可配置）。供 BackgroundTasks 调用。"""
    if not settings.feishu_notify_enabled:
        return
    if not settings.feishu_app_id or not settings.feishu_app_secret:
        log.warning("飞书通知跳过：未配置应用凭证", event="created", requirement_id=requirement_id)
        return

    db = SessionLocal()
    try:
        loaded = _load_context(db, requirement_id)
        if not loaded:
            return
        req, project, users = loaded
        recipients = resolve_owner_open_ids(db, req)
        if not recipients:
            log.warning(
                "飞书通知跳过：无负责人收件人",
                event="created",
                requirement_id=requirement_id,
                mode=settings.feishu_notify_owner_mode,
            )
            return

        status = normalize_status(req.status)
        card = _build_card(
            title="新需求待处理",
            template="blue",
            fields=[
                ("标题", req.title),
                ("项目", project.name if project else "—"),
                ("提出人", _user_name(users, req.requester_id)),
                ("优先级", PRIORITY_LABEL.get((req.priority or "unset").lower(), req.priority or "—")),
                ("状态", STATUS_LABEL.get(status, status)),
            ],
            detail_url=_detail_url(req.id),
        )
        _send_to_many(recipients, card, event="created", requirement_id=req.id)
    except Exception as exc:
        log.error("飞书新建通知异常", exc, requirement_id=requirement_id)
    finally:
        db.close()


def notify_requirement_status_changed(
    requirement_id: str,
    old_status: str,
    new_status: str,
) -> None:
    """状态边沿通知。供 BackgroundTasks 调用。"""
    if not settings.feishu_notify_enabled:
        return
    if not settings.feishu_app_id or not settings.feishu_app_secret:
        log.warning(
            "飞书通知跳过：未配置应用凭证",
            event="status",
            requirement_id=requirement_id,
        )
        return

    old_s = normalize_status(old_status)
    new_s = normalize_status(new_status)
    if old_s == new_s:
        return

    db = SessionLocal()
    try:
        loaded = _load_context(db, requirement_id)
        if not loaded:
            return
        req, project, users = loaded

        if new_s == "pending_accept":
            requester = users.get(req.requester_id) if req.requester_id else None
            oid = requester.feishu_open_id if requester else None
            if not _is_sendable_open_id(oid):
                log.warning(
                    "飞书通知跳过：提需人无有效 open_id",
                    event="pending_accept",
                    requirement_id=requirement_id,
                    requester_id=req.requester_id,
                )
                return
            card = _build_card(
                title="需求已实现，请验收",
                template="orange",
                fields=[
                    ("标题", req.title),
                    ("项目", project.name if project else "—"),
                    ("执行人", _user_name(users, req.assignee_id)),
                    ("状态", STATUS_LABEL.get(new_s, new_s)),
                ],
                detail_url=_detail_url(req.id),
            )
            _send_to_many([str(oid)], card, event="pending_accept", requirement_id=req.id)
            return

        if new_s == "wont_impl":
            requester = users.get(req.requester_id) if req.requester_id else None
            oid = requester.feishu_open_id if requester else None
            if not _is_sendable_open_id(oid):
                log.warning(
                    "飞书通知跳过：提需人无有效 open_id",
                    event="wont_impl",
                    requirement_id=requirement_id,
                    requester_id=req.requester_id,
                )
                return
            card = _build_card(
                title="需求无法实现",
                template="red",
                fields=[
                    ("标题", req.title),
                    ("项目", project.name if project else "—"),
                    ("执行人", _user_name(users, req.assignee_id)),
                    ("原因", (req.wont_reason or "").strip() or "—"),
                    ("状态", STATUS_LABEL.get(new_s, new_s)),
                ],
                detail_url=_detail_url(req.id),
            )
            _send_to_many([str(oid)], card, event="wont_impl", requirement_id=req.id)
            return

        if new_s == "done":
            recipients = resolve_owner_open_ids(db, req)
            if not recipients:
                log.warning(
                    "飞书通知跳过：无负责人收件人",
                    event="done",
                    requirement_id=requirement_id,
                    mode=settings.feishu_notify_owner_mode,
                )
                return
            card = _build_card(
                title="需求已验收完成",
                template="green",
                fields=[
                    ("标题", req.title),
                    ("项目", project.name if project else "—"),
                    ("提出人", _user_name(users, req.requester_id)),
                    ("执行人", _user_name(users, req.assignee_id)),
                    ("状态", STATUS_LABEL.get(new_s, new_s)),
                ],
                detail_url=_detail_url(req.id),
            )
            _send_to_many(recipients, card, event="done", requirement_id=req.id)
    except Exception as exc:
        log.error(
            "飞书状态通知异常",
            exc,
            requirement_id=requirement_id,
            old_status=old_s,
            new_status=new_s,
        )
    finally:
        db.close()

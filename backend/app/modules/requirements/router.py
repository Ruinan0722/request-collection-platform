from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Dict, List, Optional

from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.auth.deps import get_current_user
from app.modules.auth.executor_orgs import executor_org_display_name
from app.modules.auth.feishu_notify import (
    notify_requirement_created,
    notify_requirement_status_changed,
)
from app.modules.auth.models import User
from app.modules.projects.models import Project
from app.modules.requirements.department_stats import (
    aggregate_department_counts,
    build_weekly_pdf,
    week_bounds,
    weekly_department_stats,
    weekly_export_filename,
)
from app.modules.requirements.models import (
    Requirement,
    RequirementAttachment,
    RequirementStatusHistory,
)
from app.modules.requirements.progress import (
    DASHBOARD_BUCKETS,
    PROGRESS_NODES,
    SIDE_STATUSES,
    STATUS_LABEL,
    build_progress_nodes,
    dashboard_bucket,
    normalize_status,
    priority_rank,
    progress_index,
    status_filter_values,
)
from app.modules.requirements.schemas import (
    AttachmentOut,
    PriorityUpdate,
    RequirementCreate,
    RequirementOut,
    RequirementUpdate,
)
from app.modules.requirements.storage import save_requirement_image
from app.shared.database import get_db
from app.shared.errors import AppError, NotFoundError, ValidationError
from app.shared.logger import get_logger

log = get_logger(module="requirements")
router = APIRouter(prefix="/requirements", tags=["requirements"])


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _parse_due_date(raw: Optional[str]) -> Optional[datetime]:
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            # YYYY-MM-DD → 当天结束（UTC）
            return datetime.fromisoformat(text).replace(
                hour=23, minute=59, second=59, tzinfo=timezone.utc
            )
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError as exc:
        raise ValidationError("截止时间格式无效", details={"dueDate": raw}) from exc


# 列表「创建时间 / 业务节点」筛选使用业务本地时区（中国）
_APP_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


def _parse_day_bound(
    raw: Optional[str],
    *,
    end: bool = False,
    field: str = "date",
) -> Optional[datetime]:
    """解析筛选边界。

    - YYYY-MM-DD：按本地自然日起/止（止=当天 23:59:59.999999）
    - YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm：精确到该分钟（止含整分）
    - 带秒的 ISO：按给定时刻
    """
    if raw is None or not isinstance(raw, str):
        return None
    original = raw.strip()
    if not original:
        return None
    text = original.replace(" ", "T")
    try:
        # 纯日期：自然日起止
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            day = datetime.fromisoformat(text)
            if end:
                local = day.replace(
                    hour=23,
                    minute=59,
                    second=59,
                    microsecond=999999,
                    tzinfo=_APP_TZ,
                )
            else:
                local = day.replace(
                    hour=0,
                    minute=0,
                    second=0,
                    microsecond=0,
                    tzinfo=_APP_TZ,
                )
            return local.astimezone(timezone.utc)

        minute_only = len(text) == 16 and text[10] == "T" and text[13] == ":"
        if minute_only:
            text = f"{text}:00"

        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_APP_TZ)
        # 结束边界选到分钟时，包含该分钟内全部秒
        if end and minute_only:
            dt = dt.replace(second=59, microsecond=999999)
        return dt.astimezone(timezone.utc)
    except ValueError as exc:
        raise ValidationError("日期格式无效", details={field: raw}) from exc


def _can_set_priority(user: User) -> bool:
    return user.role == "executor"


def _is_requester(user: User) -> bool:
    return user.role == "requester"


def _is_executor(user: User) -> bool:
    return user.role == "executor"


def _can_create_requirement(user: User) -> bool:
    """需求方与执行方均可提需求（执行方可自提并自行验收）。"""
    return _is_requester(user) or _is_executor(user)


def _is_requirement_owner(req: Requirement, user: User) -> bool:
    return req.requester_id == user.id


def _attachment_out(row: RequirementAttachment) -> AttachmentOut:
    return AttachmentOut(
        id=row.id,
        fileName=row.file_name,
        contentType=row.content_type,
        sizeBytes=row.size_bytes,
        url=row.url,
        createdAt=_iso(row.created_at),
    )


def serialize_requirement(
    req: Requirement,
    project: Optional[Project] = None,
    users: Optional[Dict[str, User]] = None,
    attachments: Optional[List[RequirementAttachment]] = None,
    status_history: Optional[List[RequirementStatusHistory]] = None,
) -> dict:
    users = users or {}
    requester = users.get(req.requester_id)
    assignee = users.get(req.assignee_id) if req.assignee_id else None
    status = normalize_status(req.status)
    return RequirementOut(
        id=req.id,
        projectId=req.project_id,
        projectName=project.name if project else None,
        title=req.title,
        description=req.description,
        afterImpl=req.after_impl,
        implValue=req.impl_value,
        efficiencyGain=req.efficiency_gain,
        expectedLevel=req.expected_level or "unset",  # type: ignore[arg-type]
        priority=req.priority,  # type: ignore[arg-type]
        status=status,
        statusLabel=STATUS_LABEL.get(status, status),
        progressNodes=build_progress_nodes(status, history=status_history or []),  # type: ignore[arg-type]
        requesterId=req.requester_id,
        requesterName=requester.name if requester else None,
        assigneeId=req.assignee_id,
        # 处理方展示执行方组织名（当前仅 AI效能部；多组织时由 executor_orgs 解析）
        assigneeName=executor_org_display_name(assignee) if req.assignee_id else None,
        prioritySetBy=req.priority_set_by,
        priorityNote=req.priority_note,
        wontReason=req.wont_reason,
        dueDate=_iso(req.due_date),
        claimedAt=_iso(req.claimed_at),
        attachments=[_attachment_out(a) for a in (attachments or [])],
        createdAt=_iso(req.created_at),
        updatedAt=_iso(req.updated_at),
    ).model_dump()


def _load_users(db: Session, *user_ids: Optional[str]) -> Dict[str, User]:
    ids = [uid for uid in user_ids if uid]
    if not ids:
        return {}
    rows = db.scalars(select(User).where(User.id.in_(ids))).all()
    return {u.id: u for u in rows}


def _load_attachments_map(
    db: Session, requirement_ids: List[str]
) -> Dict[str, List[RequirementAttachment]]:
    if not requirement_ids:
        return {}
    rows = db.scalars(
        select(RequirementAttachment)
        .where(RequirementAttachment.requirement_id.in_(requirement_ids))
        .order_by(RequirementAttachment.created_at.asc())
    ).all()
    out: Dict[str, List[RequirementAttachment]] = {rid: [] for rid in requirement_ids}
    for row in rows:
        out.setdefault(row.requirement_id, []).append(row)
    return out


def _load_status_history_map(
    db: Session, requirement_ids: List[str]
) -> Dict[str, List[RequirementStatusHistory]]:
    if not requirement_ids:
        return {}
    rows = db.scalars(
        select(RequirementStatusHistory)
        .where(RequirementStatusHistory.requirement_id.in_(requirement_ids))
        .order_by(RequirementStatusHistory.entered_at.asc())
    ).all()
    out: Dict[str, List[RequirementStatusHistory]] = {rid: [] for rid in requirement_ids}
    for row in rows:
        out.setdefault(row.requirement_id, []).append(row)
    return out


def _record_status_enter(
    db: Session,
    requirement_id: str,
    status: str,
    actor_id: Optional[str],
    *,
    at: Optional[datetime] = None,
) -> None:
    """写入一次节点进入记录；若与最近一次相同则跳过。"""
    next_status = normalize_status(status)
    entered_at = at or datetime.now(timezone.utc)
    last = db.scalars(
        select(RequirementStatusHistory)
        .where(RequirementStatusHistory.requirement_id == requirement_id)
        .order_by(RequirementStatusHistory.entered_at.desc())
        .limit(1)
    ).first()
    if last and normalize_status(last.status) == next_status:
        return
    db.add(
        RequirementStatusHistory(
            id=str(uuid.uuid4()),
            requirement_id=requirement_id,
            status=next_status,
            entered_at=entered_at,
            actor_id=actor_id,
        )
    )


def _requirement_payload(
    db: Session,
    req: Requirement,
    *,
    project: Optional[Project] = None,
    users: Optional[Dict[str, User]] = None,
) -> dict:
    attachments = _load_attachments_map(db, [req.id]).get(req.id, [])
    history = _load_status_history_map(db, [req.id]).get(req.id, [])
    return serialize_requirement(
        req,
        project=project,
        users=users,
        attachments=attachments,
        status_history=history,
    )

@router.get("")
def list_requirements(
    projectId: Annotated[Optional[str], Query()] = None,
    status: Annotated[Optional[str], Query()] = None,
    priority: Annotated[Optional[str], Query()] = None,
    mine: Annotated[
        Optional[str],
        Query(description="requester=我提的 | assignee=我负责的"),
    ] = None,
    createdFrom: Annotated[
        Optional[str], Query(description="创建时间起 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm")
    ] = None,
    createdTo: Annotated[
        Optional[str], Query(description="创建时间止 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm")
    ] = None,
    dueFrom: Annotated[
        Optional[str], Query(description="期望完成时间起 YYYY-MM-DD")
    ] = None,
    dueTo: Annotated[
        Optional[str], Query(description="期望完成时间止 YYYY-MM-DD")
    ] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Requirement).order_by(Requirement.created_at.desc())
    if projectId:
        stmt = stmt.where(Requirement.project_id == projectId)
    if status:
        stmt = stmt.where(Requirement.status.in_(status_filter_values(status)))
    if priority:
        stmt = stmt.where(Requirement.priority == priority)

    created_from = _parse_day_bound(createdFrom, end=False, field="createdFrom")
    created_to = _parse_day_bound(createdTo, end=True, field="createdTo")
    due_from = _parse_day_bound(dueFrom, end=False, field="dueFrom")
    due_to = _parse_day_bound(dueTo, end=True, field="dueTo")
    if created_from and created_to and created_from > created_to:
        raise ValidationError(
            "创建时间起不能晚于止",
            details={"createdFrom": createdFrom, "createdTo": createdTo},
        )
    if due_from and due_to and due_from > due_to:
        raise ValidationError(
            "期望完成时间起不能晚于止",
            details={"dueFrom": dueFrom, "dueTo": dueTo},
        )
    if created_from:
        stmt = stmt.where(Requirement.created_at >= created_from)
    if created_to:
        stmt = stmt.where(Requirement.created_at <= created_to)
    if due_from:
        stmt = stmt.where(Requirement.due_date.is_not(None), Requirement.due_date >= due_from)
    if due_to:
        stmt = stmt.where(Requirement.due_date.is_not(None), Requirement.due_date <= due_to)

    # 需求方只能看到自己提交的需求
    if _is_requester(user):
        stmt = stmt.where(Requirement.requester_id == user.id)
    elif mine == "requester":
        # 执行方：我提的（自建需求）
        stmt = stmt.where(Requirement.requester_id == user.id)
    elif mine == "assignee":
        stmt = stmt.where(Requirement.assignee_id == user.id)
    elif mine == "unassigned":
        # 兼容旧筛选参数：不再表示「待接取」，改为无负责人
        stmt = stmt.where(Requirement.assignee_id.is_(None))
    elif mine == "mine":
        # 执行方：我负责的
        stmt = stmt.where(Requirement.assignee_id == user.id)

    reqs = db.scalars(stmt).all()
    project_ids = {r.project_id for r in reqs}
    projects = {
        p.id: p
        for p in db.scalars(select(Project).where(Project.id.in_(project_ids))).all()
    } if project_ids else {}
    user_ids = set()
    for r in reqs:
        user_ids.add(r.requester_id)
        if r.assignee_id:
            user_ids.add(r.assignee_id)
    users = {
        u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids))).all()
    } if user_ids else {}
    attachments_map = _load_attachments_map(db, [r.id for r in reqs])
    history_map = _load_status_history_map(db, [r.id for r in reqs])

    data = [
        serialize_requirement(
            r,
            project=projects.get(r.project_id),
            users=users,
            attachments=attachments_map.get(r.id, []),
            status_history=history_map.get(r.id, []),
        )
        for r in reqs
    ]
    data.sort(
        key=lambda i: (
            priority_rank(i.get("priority")),
            i.get("dueDate") or "9999",
            i.get("createdAt") or "",
        )
    )
    return {"success": True, "data": data}


@router.get("/board")
def requirements_board(
    projectId: Optional[str] = Query(default=None),
    mine: Optional[str] = Query(default=None),
    createdFrom: Optional[str] = Query(default=None),
    createdTo: Optional[str] = Query(default=None),
    dueFrom: Optional[str] = Query(default=None),
    dueTo: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """跨项目看板：按进度节点分列。"""
    listed = list_requirements(
        projectId=projectId,
        status=None,
        priority=None,
        mine=mine,
        createdFrom=createdFrom,
        createdTo=createdTo,
        dueFrom=dueFrom,
        dueTo=dueTo,
        user=user,
        db=db,
    )
    items = listed["data"]
    columns = []
    for code, label in [
        ("evaluating", "待评优先级"),
        ("waiting_impl", "等待实现"),
        ("implementing", "实现中"),
        ("pending_accept", "等待验收"),
        ("done", "已完成"),
        ("wont_impl", "无法实现"),
    ]:
        columns.append(
            {
                "status": code,
                "label": label,
                "items": sorted(
                    [i for i in items if normalize_status(i.get("status", "")) == code],
                    key=lambda i: (
                        priority_rank(i.get("priority")),
                        i.get("dueDate") or "9999",
                        i.get("createdAt") or "",
                    ),
                ),
            }
        )
    return {"success": True, "data": {"columns": columns, "total": len(items)}}


@router.get("/dashboard")
def requirements_dashboard(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """工作台：需求总量 / 各阶段数量 / 各部门提需与解决统计。"""
    _ = user
    listed = list_requirements(
        projectId=None,
        status=None,
        priority=None,
        mine=None,
        createdFrom=None,
        createdTo=None,
        dueFrom=None,
        dueTo=None,
        user=user,
        db=db,
    )
    items = listed["data"]

    # 各阶段计数（含旁路「无法实现」）
    stage_defs = list(PROGRESS_NODES) + list(SIDE_STATUSES.items())
    stage_counts = {code: 0 for code, _label in stage_defs}
    for item in items:
        code = normalize_status(item.get("status") or "evaluating")
        if code in stage_counts:
            stage_counts[code] += 1
        else:
            stage_counts.setdefault(code, 0)
            stage_counts[code] += 1

    stages = [
        {"code": code, "label": label, "count": stage_counts.get(code, 0)}
        for code, label in stage_defs
    ]

    requester_ids = {i.get("requesterId") for i in items if i.get("requesterId")}
    users = {
        u.id: u
        for u in db.scalars(select(User).where(User.id.in_(requester_ids))).all()
    } if requester_ids else {}

    departments = aggregate_department_counts(items, users)
    total = len(items)

    start, end, from_label, to_label = week_bounds()
    weekly_rows = weekly_department_stats(db, start=start, end=end, with_items=False)
    weekly = {
        "from": from_label,
        "to": to_label,
        "departments": weekly_rows,
        "submittedTotal": sum(int(r.get("submitted") or 0) for r in weekly_rows),
        "solvedTotal": sum(int(r.get("solved") or 0) for r in weekly_rows),
    }

    projects = db.scalars(select(Project).order_by(Project.created_at.desc())).all()
    project_cards = []
    for project in projects:
        project_items = [i for i in items if i.get("projectId") == project.id]
        counts = {b[0]: 0 for b in DASHBOARD_BUCKETS}
        for i in project_items:
            b = dashboard_bucket(i.get("status", ""))
            counts[b] = counts.get(b, 0) + 1

        project_cards.append(
            {
                "id": project.id,
                "name": project.name,
                "description": project.description,
                "requirementCount": len(project_items),
                "counts": {
                    "todo": counts.get("todo", 0),
                    "doing": counts.get("doing", 0),
                    "done": counts.get("done", 0),
                    "wont": counts.get("wont", 0),
                },
                "preview": [
                    {
                        "id": i["id"],
                        "title": i["title"],
                        "status": i["status"],
                        "statusLabel": i.get("statusLabel"),
                        "priority": i.get("priority"),
                    }
                    for i in sorted(
                        project_items,
                        key=lambda x: (
                            priority_rank(x.get("priority")),
                            x.get("dueDate") or "9999",
                        ),
                    )[:5]
                ],
            }
        )

    return {
        "success": True,
        "data": {
            "total": total,
            "stages": stages,
            "departments": departments,
            "weekly": weekly,
            "projects": project_cards,
        },
    }


@router.get("/stats/departments/weekly")
def department_weekly_stats(
    fromDay: Annotated[Optional[str], Query()] = None,
    toDay: Annotated[Optional[str], Query()] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """近一周（可自定义区间）各部门提出数 / 解决数。"""
    if not _is_executor(user):
        raise AppError("仅执行方可查看部门周统计", status_code=403, code="FORBIDDEN")
    try:
        start, end, from_label, to_label = week_bounds(from_day=fromDay, to_day=toDay)
    except ValueError as exc:
        raise ValidationError("日期格式无效，请使用 YYYY-MM-DD", details={"error": str(exc)}) from exc

    rows = weekly_department_stats(db, start=start, end=end, with_items=False)
    return {
        "success": True,
        "data": {
            "from": from_label,
            "to": to_label,
            "departments": rows,
            "submittedTotal": sum(int(r.get("submitted") or 0) for r in rows),
            "solvedTotal": sum(int(r.get("solved") or 0) for r in rows),
        },
    }


@router.get("/stats/departments/weekly/export")
def export_department_weekly_stats(
    fromDay: Annotated[Optional[str], Query()] = None,
    toDay: Annotated[Optional[str], Query()] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """导出一周各部门提出 / 解决统计及需求明细（PDF）。"""
    if not _is_executor(user):
        raise AppError("仅执行方可导出部门周统计", status_code=403, code="FORBIDDEN")
    try:
        start, end, from_label, to_label = week_bounds(from_day=fromDay, to_day=toDay)
    except ValueError as exc:
        raise ValidationError("日期格式无效，请使用 YYYY-MM-DD", details={"error": str(exc)}) from exc

    rows = weekly_department_stats(db, start=start, end=end, with_items=True)
    content = build_weekly_pdf(rows, from_label=from_label, to_label=to_label)
    filename = weekly_export_filename(from_label=from_label, to_label=to_label, ext="pdf")
    # ASCII 兜底 + UTF-8 文件名，兼容各浏览器
    ascii_name = f"dept-weekly-{from_label}_{to_label}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(filename)}"
            ),
            "Cache-Control": "no-store",
        },
    )


@router.post("")
def create_requirement(
    body: RequirementCreate,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if not _can_create_requirement(user):
        raise AppError("无权创建需求", status_code=403, code="FORBIDDEN")

    project = db.get(Project, body.projectId)
    if not project:
        raise ValidationError("绑定的项目不存在", details={"projectId": body.projectId})

    # 提需人记为当前用户（执行方自提时 requester_id 为自己，后续可自行验收）
    # 负责人在推进进度时自动记录；执行方自提后仍可兼作执行方推进
    assignee_id = None
    claimed_at = None

    expected = (body.expectedLevel or "unset").strip().lower()
    if expected not in {"unset", "p0", "p1", "p2", "p3"}:
        raise ValidationError("无效的预期等级", details={"expectedLevel": body.expectedLevel})

    req = Requirement(
        id=str(uuid.uuid4()),
        project_id=project.id,
        title=body.title.strip(),
        description=(body.description or "").strip() or None,
        after_impl=(body.afterImpl or "").strip() or None,
        impl_value=(body.implValue or "").strip() or None,
        efficiency_gain=(body.efficiencyGain or "").strip() or None,
        expected_level=expected,
        priority="unset",
        status="evaluating",
        requester_id=user.id,
        assignee_id=assignee_id,
        due_date=_parse_due_date(body.dueDate),
        claimed_at=claimed_at,
    )
    db.add(req)
    db.flush()
    _record_status_enter(db, req.id, "evaluating", user.id)
    db.commit()
    db.refresh(req)
    log.info(
        "创建需求",
        requirement_id=req.id,
        project_id=project.id,
        requester_id=user.id,
        assignee_id=assignee_id,
    )
    background_tasks.add_task(notify_requirement_created, req.id)
    users = _load_users(db, req.requester_id, req.assignee_id)
    return {"success": True, "data": _requirement_payload(db, req, project=project, users=users)}


@router.get("/{requirement_id}")
def get_requirement(
    requirement_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    req = db.get(Requirement, requirement_id)
    if not req:
        raise NotFoundError("需求不存在")
    if _is_requester(user) and req.requester_id != user.id:
        raise AppError(
            "无权查看该需求：这不是当前账号提交的需求，请用原提需账号登录（开发环境请点「需求方测试账号」）",
            status_code=403,
            code="FORBIDDEN",
        )
    project = db.get(Project, req.project_id)
    users = _load_users(db, req.requester_id, req.assignee_id, req.priority_set_by)
    return {
        "success": True,
        "data": _requirement_payload(db, req, project=project, users=users),
    }


@router.post("/{requirement_id}/attachments")
async def upload_attachment(
    requirement_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    req = db.get(Requirement, requirement_id)
    if not req:
        raise NotFoundError("需求不存在")

    is_owner = req.requester_id == user.id
    is_assignee = req.assignee_id == user.id
    if not (is_owner or is_assignee or _is_executor(user)):
        raise AppError("无权上传附件", status_code=403, code="FORBIDDEN")

    saved = await save_requirement_image(requirement_id, file)
    row = RequirementAttachment(
        id=saved["id"],
        requirement_id=requirement_id,
        file_name=saved["file_name"],
        content_type=saved["content_type"],
        size_bytes=saved["size_bytes"],
        storage_path=saved["storage_path"],
        url=saved["url"],
        uploader_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    log.info("上传需求附件", requirement_id=requirement_id, attachment_id=row.id)
    return {"success": True, "data": _attachment_out(row).model_dump()}


@router.delete("/{requirement_id}")
def delete_requirement(
    requirement_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """删除需求：执行方可删任意需求；需求方仅可删自己尚未进入实现（待评优先级）的需求。

    级联删除状态历史与附件记录；附件物理文件按需求目录清理（尽力而为）。
    """
    req = db.get(Requirement, requirement_id)
    if not req:
        raise NotFoundError("需求不存在")
    is_owner_requester = _is_requirement_owner(req, user)
    is_executor = _can_set_priority(user)
    current_status = normalize_status(req.status)
    if not (is_executor or (is_owner_requester and current_status == "evaluating")):
        raise AppError(
            "无权删除该需求：执行方可删除，需求方仅可删除自己待评优先级的需求",
            status_code=403,
            code="FORBIDDEN",
        )
    # 清理附件物理文件（尽力而为，失败不影响删除主流程）
    attachments = db.scalars(
        select(RequirementAttachment).where(RequirementAttachment.requirement_id == requirement_id)
    ).all()
    removed = 0
    for att in attachments:
        if not att.storage_path:
            continue
        try:
            path = Path(att.storage_path)
            if path.is_file():
                path.unlink()
                removed += 1
        except OSError:
            log.warning("删除附件文件失败", requirement_id=requirement_id, path=att.storage_path)
    db.delete(req)
    db.commit()
    log.info(
        "删除需求",
        requirement_id=requirement_id,
        title=req.title,
        operator=user.id,
        attachments_removed=removed,
    )
    return {"success": True, "data": {"id": requirement_id}}


@router.patch("/{requirement_id}")
def update_requirement(
    requirement_id: str,
    body: RequirementUpdate,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    req = db.get(Requirement, requirement_id)
    if not req:
        raise NotFoundError("需求不存在")

    is_owner_requester = _is_requirement_owner(req, user)
    is_executor = _can_set_priority(user)
    if not (is_owner_requester or is_executor):
        raise AppError("无权修改该需求", status_code=403, code="FORBIDDEN")

    status_changed_from: Optional[str] = None
    status_changed_to: Optional[str] = None

    if body.title is not None:
        req.title = body.title.strip()
    if body.description is not None:
        req.description = body.description.strip() or None
    if body.dueDate is not None:
        if not (is_owner_requester or is_executor):
            raise AppError("无权修改截止时间", status_code=403, code="FORBIDDEN")
        req.due_date = _parse_due_date(body.dueDate)
    if body.status is not None:
        next_status = normalize_status(body.status)
        if next_status not in STATUS_LABEL:
            raise ValidationError("无效的进度节点", details={"status": body.status})

        current_status = normalize_status(req.status)
        # 终态锁定：已验收完成的需求不可再变更进度（防止绕过 UI 返工）
        if current_status == "done" and next_status != "done":
            raise ValidationError(
                "已验收完成的需求为终态，不可再变更进度",
                details={"status": current_status},
            )
        # 主链回退限制：仅允许回退一档（撤销误操作）；禁止跨多档回退与回退到评估阶段
        # 旁路「无法实现」不受此限；状态变更通知已覆盖回退场景
        if next_status != "wont_impl" and current_status != "wont_impl":
            if progress_index(next_status) < progress_index(current_status) - 1:
                raise ValidationError(
                    "进度节点仅可回退一档（撤销误操作），请选择相邻或后续节点",
                    details={"current": current_status, "next": next_status},
                )
            if next_status == "evaluating":
                raise ValidationError(
                    "进度节点不可回退到「待评优先级」",
                    details={"current": current_status, "next": next_status},
                )
        # 从「无法实现」恢复：仅允许回到实现环节，不允许重新进入评估/等待
        if current_status == "wont_impl" and next_status not in {"implementing", "pending_accept"}:
            raise ValidationError(
                "从「无法实现」恢复请选择「实现中」或「已实现等待验收」",
                details={"status": current_status},
            )
        if current_status == "evaluating" and next_status != "evaluating":
            raise ValidationError(
                "当前处于待评优先级，请先绑定优先级后再推进进度",
                details={"status": current_status},
            )

        if next_status == "done":
            # 仅提需人可确认验收；执行方最多推进到「已实现等待验收」
            if not is_owner_requester:
                raise AppError(
                    "仅需求提出方可确认验收完成",
                    status_code=403,
                    code="FORBIDDEN",
                )
            if current_status != "pending_accept":
                raise ValidationError(
                    "请先进入「已实现等待验收」，由提出人确认后再完成",
                    details={"status": current_status},
                )
        elif not is_executor:
            raise AppError("仅执行方可推进实现进度", status_code=403, code="FORBIDDEN")

        # 推进实现链路时，若尚无负责人则自动记为当前操作人（不再走接单）
        if (
            is_executor
            and next_status in {"implementing", "pending_accept", "wont_impl"}
            and not req.assignee_id
        ):
            req.assignee_id = user.id
            if not req.claimed_at:
                req.claimed_at = datetime.now(timezone.utc)

        if next_status == "wont_impl":
            reason = (body.wontReason if body.wontReason is not None else req.wont_reason) or ""
            reason = reason.strip()
            if not reason:
                raise ValidationError("请填写无法实现的原因", details={"wontReason": "required"})
            req.wont_reason = reason
        else:
            # 离开无法实现时清空原因
            if normalize_status(req.status) == "wont_impl":
                req.wont_reason = None

        if next_status != current_status:
            status_changed_from = current_status
            status_changed_to = next_status
            req.status = next_status
            _record_status_enter(db, req.id, next_status, user.id)
    elif body.wontReason is not None and normalize_status(req.status) == "wont_impl":
        # 已在无法实现状态下可单独更新原因
        if not is_executor:
            raise AppError("仅执行方可修改无法实现原因", status_code=403, code="FORBIDDEN")
        reason = body.wontReason.strip()
        if not reason:
            raise ValidationError("请填写无法实现的原因", details={"wontReason": "required"})
        req.wont_reason = reason
    if body.assigneeId is not None:
        raise ValidationError(
            "负责人在推进进度时自动记录，不可手动修改",
            details={"assigneeId": "locked"},
        )

    db.commit()
    db.refresh(req)
    if status_changed_from is not None and status_changed_to in {
        "pending_accept",
        "done",
        "wont_impl",
    }:
        background_tasks.add_task(
            notify_requirement_status_changed,
            req.id,
            status_changed_from,
            status_changed_to,
        )
    project = db.get(Project, req.project_id)
    users = _load_users(db, req.requester_id, req.assignee_id, req.priority_set_by)
    return {
        "success": True,
        "data": _requirement_payload(db, req, project=project, users=users),
    }


@router.patch("/{requirement_id}/priority")
def update_priority(
    requirement_id: str,
    body: PriorityUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """人工评判优先级：执行方操作。"""
    if not _can_set_priority(user):
        raise AppError("仅执行方可评判优先级", status_code=403, code="FORBIDDEN")

    req = db.get(Requirement, requirement_id)
    if not req:
        raise NotFoundError("需求不存在")

    if normalize_status(req.status) != "evaluating":
        raise ValidationError(
            "仅待评优先级阶段可绑定优先级",
            details={"status": req.status},
        )

    if body.priority == "unset":
        raise ValidationError(
            "待评优先级阶段必须绑定具体优先级",
            details={"priority": body.priority},
        )

    req.priority = body.priority
    req.priority_set_by = user.id
    req.priority_note = (body.note or "").strip() or None
    req.status = "waiting_impl"
    _record_status_enter(db, req.id, "waiting_impl", user.id)

    db.commit()
    db.refresh(req)
    log.info(
        "人工设置优先级",
        requirement_id=req.id,
        priority=req.priority,
        operator=user.id,
    )
    project = db.get(Project, req.project_id)
    users = _load_users(db, req.requester_id, req.assignee_id, req.priority_set_by)
    return {
        "success": True,
        "data": _requirement_payload(db, req, project=project, users=users),
    }

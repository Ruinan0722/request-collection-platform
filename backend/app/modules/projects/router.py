from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.auth.deps import get_current_user
from app.modules.auth.models import User
from app.modules.projects.models import Project, ProjectMember
from app.modules.projects.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.modules.requirements.models import Requirement
from app.shared.database import get_db
from app.shared.errors import AppError, NotFoundError, ValidationError
from app.shared.logger import get_logger

log = get_logger(module="projects")
router = APIRouter(prefix="/projects", tags=["projects"])

STATUS_COLUMNS = [
    ("evaluating", "待评优先级"),
    ("waiting_impl", "等待实现"),
    ("implementing", "实现中"),
    ("pending_accept", "已实现等待验收"),
    ("done", "已验收完成"),
    ("wont_impl", "无法实现"),
]


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _project_out(project: Project, count: int = 0) -> dict:
    return ProjectOut(
        id=project.id,
        name=project.name,
        description=project.description,
        ownerId=project.owner_id,
        requirementCount=count,
        createdAt=_iso(project.created_at),
    ).model_dump()


@router.get("")
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    _ = user
    projects = db.scalars(select(Project).order_by(Project.created_at.desc())).all()
    counts = dict(
        db.execute(
            select(Requirement.project_id, func.count())
            .group_by(Requirement.project_id)
        ).all()
    )
    data = [_project_out(p, int(counts.get(p.id, 0))) for p in projects]
    return {"success": True, "data": data}


@router.post("")
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    exists = db.scalar(select(Project).where(Project.name == body.name.strip()))
    if exists:
        raise ValidationError("项目名称已存在")

    project = Project(
        id=str(uuid.uuid4()),
        name=body.name.strip(),
        description=(body.description or "").strip() or None,
        owner_id=user.id,
    )
    db.add(project)
    db.add(
        ProjectMember(
            id=str(uuid.uuid4()),
            project_id=project.id,
            user_id=user.id,
            member_role="executor" if user.role == "executor" else "requester",
        )
    )
    db.commit()
    db.refresh(project)
    log.info("创建项目", project_id=project.id, name=project.name, user_id=user.id)
    return {"success": True, "data": _project_out(project, 0)}


@router.get("/{project_id}")
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _ = user
    project = db.get(Project, project_id)
    if not project:
        raise NotFoundError("项目不存在")
    count = db.scalar(
        select(func.count()).select_from(Requirement).where(Requirement.project_id == project_id)
    ) or 0
    return {"success": True, "data": _project_out(project, int(count))}


@router.patch("/{project_id}")
def update_project(
    project_id: str,
    body: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise NotFoundError("项目不存在")
    if project.owner_id != user.id and user.role != "executor":
        raise ValidationError("仅项目负责人或执行方可修改项目")

    if body.name is not None:
        name = body.name.strip()
        other = db.scalar(select(Project).where(Project.name == name, Project.id != project_id))
        if other:
            raise ValidationError("项目名称已存在")
        project.name = name
    if body.description is not None:
        project.description = body.description.strip() or None

    db.commit()
    db.refresh(project)
    count = db.scalar(
        select(func.count()).select_from(Requirement).where(Requirement.project_id == project_id)
    ) or 0
    return {"success": True, "data": _project_out(project, int(count))}


@router.get("/{project_id}/board")
def project_board(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.modules.requirements.router import serialize_requirement

    if user.role == "requester":
        raise AppError("需求方无权查看项目看板", status_code=403, code="FORBIDDEN")

    project = db.get(Project, project_id)
    if not project:
        raise NotFoundError("项目不存在")

    reqs = db.scalars(
        select(Requirement)
        .where(Requirement.project_id == project_id)
        .order_by(Requirement.sort_order.asc(), Requirement.created_at.desc())
    ).all()

    from app.modules.requirements.progress import normalize_status, priority_rank

    users = {u.id: u for u in db.scalars(select(User)).all()}
    columns = []
    for status, label in STATUS_COLUMNS:
        items = [
            serialize_requirement(r, project=project, users=users)
            for r in reqs
            if normalize_status(r.status) == status
        ]
        items.sort(
            key=lambda i: (
                priority_rank(i.get("priority")),
                i.get("dueDate") or "9999",
                i.get("createdAt") or "",
            )
        )
        columns.append({"status": status, "label": label, "items": items})

    return {
        "success": True,
        "data": {
            "project": _project_out(project, len(reqs)),
            "columns": columns,
        },
    }

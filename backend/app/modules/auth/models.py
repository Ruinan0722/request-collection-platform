from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import JSON, Boolean, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    feishu_open_id: Mapped[Optional[str]] = mapped_column(String(128), unique=True, nullable=True, index=True)
    feishu_union_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    name: Mapped[str] = mapped_column(String(128))
    avatar_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # requester | executor
    role: Mapped[str] = mapped_column(String(32), default="requester", index=True)
    # feishu | manual | dev
    role_source: Mapped[str] = mapped_column(String(32), default="manual")
    role_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    department_ids: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    department_names: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )


class FeishuDepartment(Base):
    """飞书部门树快照。"""

    __tablename__ = "feishu_departments"

    open_department_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    parent_department_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    raw: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )

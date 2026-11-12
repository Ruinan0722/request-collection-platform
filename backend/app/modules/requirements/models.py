from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


class Requirement(Base):
    __tablename__ = "requirements"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # 需求方填写：实现后效果 / 价值 / 效率收益 / 预期等级
    after_impl: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    impl_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    efficiency_gain: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # unset | p0 | p1 | p2 | p3 —— 需求方预期等级（与 AI效能部 评定的 priority 分开）
    expected_level: Mapped[str] = mapped_column(String(16), default="unset", index=True)
    # unset | p0 | p1 | p2 | p3  —— 人工评判
    priority: Mapped[str] = mapped_column(String(16), default="unset", index=True)
    # evaluating | waiting_impl | implementing | pending_accept | done | wont_impl
    status: Mapped[str] = mapped_column(String(32), default="evaluating", index=True)
    requester_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id"), index=True)
    assignee_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("users.id"), nullable=True, index=True)
    priority_set_by: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("users.id"), nullable=True)
    priority_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    wont_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    due_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    claimed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )


class RequirementAttachment(Base):
    __tablename__ = "requirement_attachments"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    requirement_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("requirements.id", ondelete="CASCADE"), index=True
    )
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    storage_path: Mapped[str] = mapped_column(String(512))
    url: Mapped[str] = mapped_column(String(512))
    uploader_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RequirementStatusHistory(Base):
    """节点进入记录：每次进入某状态写一条，用于展示转换时间与阶段耗时。"""

    __tablename__ = "requirement_status_history"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    requirement_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("requirements.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), index=True)
    entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    actor_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("users.id"), nullable=True)

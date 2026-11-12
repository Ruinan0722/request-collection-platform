from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


PriorityType = Literal["unset", "p0", "p1", "p2", "p3"]
StatusType = Literal[
    "backlog",
    "evaluating",
    "waiting_impl",
    "implementing",
    "pending_accept",
    "done",
    "wont_impl",
    # 兼容旧值
    "todo",
    "doing",
]


class RequirementCreate(BaseModel):
    projectId: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=10000)
    afterImpl: Optional[str] = Field(default=None, max_length=5000)
    implValue: Optional[str] = Field(default=None, max_length=5000)
    efficiencyGain: Optional[str] = Field(default=None, max_length=2000)
    expectedLevel: PriorityType = "unset"
    assigneeId: Optional[str] = None
    dueDate: Optional[str] = None  # ISO 日期或日期时间


class RequirementUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=10000)
    status: Optional[StatusType] = None
    assigneeId: Optional[str] = None
    dueDate: Optional[str] = None
    wontReason: Optional[str] = Field(default=None, max_length=2000)


class PriorityUpdate(BaseModel):
    priority: PriorityType
    note: Optional[str] = Field(default=None, max_length=2000)


class ProgressNodeOut(BaseModel):
    code: str
    label: str
    state: Literal["done", "current", "pending"]
    enteredAt: Optional[str] = None
    leftAt: Optional[str] = None
    durationMinutes: Optional[int] = None
    durationLabel: Optional[str] = None


class AttachmentOut(BaseModel):
    id: str
    fileName: str
    contentType: str
    sizeBytes: int
    url: str
    createdAt: Optional[str] = None


class RequirementOut(BaseModel):
    id: str
    projectId: str
    projectName: Optional[str] = None
    title: str
    description: Optional[str] = None
    afterImpl: Optional[str] = None
    implValue: Optional[str] = None
    efficiencyGain: Optional[str] = None
    expectedLevel: PriorityType = "unset"
    priority: PriorityType
    status: str
    statusLabel: Optional[str] = None
    progressNodes: List[ProgressNodeOut] = []
    requesterId: str
    requesterName: Optional[str] = None
    assigneeId: Optional[str] = None
    assigneeName: Optional[str] = None
    prioritySetBy: Optional[str] = None
    priorityNote: Optional[str] = None
    wontReason: Optional[str] = None
    dueDate: Optional[str] = None
    claimedAt: Optional[str] = None
    attachments: List[AttachmentOut] = []
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None

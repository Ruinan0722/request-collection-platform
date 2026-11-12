from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=2000)


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=2000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    ownerId: str
    requirementCount: int = 0
    createdAt: Optional[str] = None


class KanbanColumn(BaseModel):
    status: str
    label: str
    items: List[dict]

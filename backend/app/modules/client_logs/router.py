from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.modules.client_logs.models import ClientErrorLog
from app.shared.database import get_db
from app.shared.errors import ValidationError
from app.shared.logger import get_logger

log = get_logger(module="client-logs")
router = APIRouter(prefix="/client-logs", tags=["client-logs"])

LogLevel = Literal["debug", "info", "warn", "error"]


class ClientLogItem(BaseModel):
    level: LogLevel
    message: str = Field(min_length=1, max_length=4000)
    stack: Optional[str] = Field(default=None, max_length=20000)
    file: Optional[str] = Field(default=None, max_length=1000)
    line: Optional[int] = None
    column: Optional[int] = None
    url: Optional[str] = Field(default=None, max_length=2000)
    userAgent: Optional[str] = Field(default=None, max_length=1000)
    context: Optional[Dict[str, Any]] = None


class ClientLogBatch(BaseModel):
    logs: List[ClientLogItem] = Field(min_length=1, max_length=50)


@router.post("")
def ingest_client_logs(payload: ClientLogBatch, db: Session = Depends(get_db)) -> dict:
    if not payload.logs:
        raise ValidationError("前端日志格式不正确", details={"logs": "不能为空"})

    for item in payload.logs:
        message = f"[frontend] {item.message}"
        common = {
            "source": "frontend",
            "file": item.file,
            "line": item.line,
            "column": item.column,
            "url": item.url,
            "userAgent": item.userAgent,
            "context": item.context,
        }

        if item.level == "error":
            log.error(message, stack=item.stack, **common)
        elif item.level == "warn":
            log.warn(message, **common)
        else:
            log.info(message, **common)

    error_logs = [item for item in payload.logs if item.level == "error"]
    for item in error_logs:
        db.add(
            ClientErrorLog(
                id=str(uuid.uuid4()),
                level=item.level,
                message=item.message,
                stack=item.stack,
                file=item.file,
                line=item.line,
                column=item.column,
                url=item.url,
                user_agent=item.userAgent,
                context=item.context,
            )
        )
    if error_logs:
        db.commit()

    return {"success": True, "data": {"accepted": len(payload.logs)}}

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter
from sqlalchemy import text

from app.shared.database import SessionLocal
from app.shared.logger import get_logger

log = get_logger(module="health")
router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def health_check() -> dict:
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        log.debug("健康检查通过")
        return {
            "success": True,
            "data": {
                "status": "ok",
                "service": "fullstack-infra-backend",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "database": "connected",
            },
        }
    except Exception as exc:
        log.error("健康检查失败：数据库不可用", exc)
        raise


@router.get("/error-demo")
def error_demo() -> None:
    """故意抛错，用于验证日志是否记录完整 stack / 文件位置。"""
    raise RuntimeError("这是一条故意触发的演示错误，用于验证日志系统")

"""集中注册功能模块；新增功能只需在此追加 router，互不影响。"""

from fastapi import APIRouter

from app.modules.auth import router as auth_router
from app.modules.client_logs import router as client_logs_router
from app.modules.health import router as health_router
from app.modules.projects import router as projects_router
from app.modules.requirements import router as requirements_router


def register_modules(api: APIRouter) -> None:
    api.include_router(health_router)
    api.include_router(client_logs_router)
    api.include_router(auth_router)
    api.include_router(projects_router)
    api.include_router(requirements_router)

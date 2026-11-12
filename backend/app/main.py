from __future__ import annotations

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config.settings import settings
from app.modules import register_modules
from app.modules.requirements.storage import get_upload_root
from app.shared.database import init_database
from app.shared.errors import AppError
from app.shared.logger import get_logger, setup_logging
from app.shared.middleware import RequestContextMiddleware

setup_logging()
log = get_logger(module="app")


def create_app() -> FastAPI:
    application = FastAPI(
        title="需求收集平台",
        version="1.0.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-Id"],
    )
    application.add_middleware(RequestContextMiddleware)

    api = APIRouter(prefix="/api")
    register_modules(api)
    application.include_router(api)

    upload_root = get_upload_root()
    application.mount("/uploads", StaticFiles(directory=str(upload_root)), name="uploads")

    @application.on_event("startup")
    def on_startup() -> None:
        init_database()
        get_upload_root()
        if settings.feishu_configured and settings.feishu_org_sync_on_startup:
            try:
                from app.modules.auth.org_sync import sync_org_from_roots
                from app.shared.database import SessionLocal

                db = SessionLocal()
                try:
                    result = sync_org_from_roots(db)
                    log.info("启动时组织同步完成", **{k: result.get(k) for k in ("departments", "users", "ok")})
                finally:
                    db.close()
            except Exception as exc:
                log.error("启动时组织同步失败（不影响服务）", exc)
        log.info(
            "后端服务已启动",
            port=settings.backend_port,
            env=settings.app_env,
            url=f"http://localhost:{settings.backend_port}",
        )

    @application.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        log.error(
            exc.message,
            exc,
            request_id=request_id,
            code=exc.code,
            status_code=exc.status_code,
            details=exc.details,
            path=str(request.url.path),
            method=request.method,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "success": False,
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details,
                    "requestId": request_id,
                },
            },
        )

    @application.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        log.warn(
            "参数校验失败",
            request_id=request_id,
            path=str(request.url.path),
            method=request.method,
            details=exc.errors(),
        )
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "参数校验失败",
                    "details": exc.errors(),
                    "requestId": request_id,
                },
            },
        )

    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        if exc.status_code == 404:
            return JSONResponse(
                status_code=404,
                content={
                    "success": False,
                    "error": {
                        "code": "NOT_FOUND",
                        "message": f"接口不存在: {request.method} {request.url.path}",
                        "requestId": request_id,
                    },
                },
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "success": False,
                "error": {
                    "code": "HTTP_ERROR",
                    "message": exc.detail,
                    "requestId": request_id,
                },
            },
        )

    @application.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        log.error(
            "未捕获异常",
            exc,
            request_id=request_id,
            path=str(request.url.path),
            method=request.method,
        )
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "服务器内部错误",
                    "requestId": request_id,
                },
            },
        )

    return application


app = create_app()

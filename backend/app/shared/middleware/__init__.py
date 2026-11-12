from __future__ import annotations

import time
import uuid
from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.shared.logger import get_logger

log = get_logger(module="http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """为每个请求注入 request_id，并记录请求摘要。"""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()

        log.info(
            "Incoming request",
            request_id=request_id,
            method=request.method,
            path=str(request.url.path),
        )

        response = await call_next(request)

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-Id"] = request_id
        log.info(
            "Request completed",
            request_id=request_id,
            method=request.method,
            path=str(request.url.path),
            status_code=response.status_code,
            duration_ms=duration_ms,
        )
        return response

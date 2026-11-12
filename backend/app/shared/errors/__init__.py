from __future__ import annotations

from typing import Any, Optional


class AppError(Exception):
    """可预期业务错误。"""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        code: str = "INTERNAL_ERROR",
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details


class NotFoundError(AppError):
    def __init__(self, message: str = "资源不存在", details: Any = None) -> None:
        super().__init__(message, status_code=404, code="NOT_FOUND", details=details)


class ValidationError(AppError):
    def __init__(self, message: str = "参数校验失败", details: Any = None) -> None:
        super().__init__(message, status_code=400, code="VALIDATION_ERROR", details=details)

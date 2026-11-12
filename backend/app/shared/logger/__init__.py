from __future__ import annotations

import json
import logging
import sys
import traceback
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

from app.config.settings import BACKEND_ROOT, settings

LOG_DIR = BACKEND_ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

_RESERVED = {
    "name",
    "msg",
    "args",
    "levelname",
    "levelno",
    "pathname",
    "filename",
    "module",
    "exc_info",
    "exc_text",
    "stack_info",
    "lineno",
    "funcName",
    "created",
    "msecs",
    "relativeCreated",
    "thread",
    "threadName",
    "processName",
    "process",
    "message",
    "asctime",
}


def parse_stack_location(stack: Optional[str] = None, *, skip_logger: bool = True) -> Dict[str, Any]:
    """从 stack 文本或当前调用栈解析文件 / 行号 / 函数名。"""
    app_root = str((BACKEND_ROOT / "app").resolve())

    def _is_noise(path: str) -> bool:
        posix = path.replace("\\", "/")
        if skip_logger and "/logger/" in posix:
            return True
        if "site-packages" in posix:
            return True
        if posix.endswith("logging/__init__.py"):
            return True
        # 优先业务代码：非项目内路径视为噪声（有业务帧时）
        return False

    def _is_app_code(path: str) -> bool:
        try:
            return str(Path(path).resolve()).startswith(app_root)
        except Exception:
            return "/app/" in path.replace("\\", "/")

    if stack:
        app_candidates = []
        other_candidates = []
        for line in stack.splitlines():
            line = line.strip()
            if not line:
                continue

            if 'File "' in line and ", line " in line:
                try:
                    file_part = line.split('File "')[1].split('"', 1)[0]
                    line_no = int(line.split(", line ")[1].split(",", 1)[0])
                    func = line.split(" in ")[-1] if " in " in line else None
                    if _is_noise(file_part):
                        continue
                    item = {"file": file_part, "line": line_no, "functionName": func}
                    if _is_app_code(file_part):
                        app_candidates.append(item)
                    else:
                        other_candidates.append(item)
                except (IndexError, ValueError):
                    continue
                continue

            if line.startswith("at "):
                try:
                    if "(" in line and ")" in line:
                        loc = line.rsplit("(", 1)[1].rstrip(")")
                        func = line[3:].split("(", 1)[0].strip() or None
                    else:
                        loc = line[3:].strip()
                        func = None
                    parts = loc.rsplit(":", 2)
                    if len(parts) < 3:
                        continue
                    file_path, line_s, col_s = parts[0], parts[1], parts[2]
                    if _is_noise(file_path):
                        continue
                    return {
                        "file": file_path,
                        "line": int(line_s),
                        "column": int(col_s),
                        "functionName": func,
                    }
                except (ValueError, IndexError):
                    continue

        # traceback 从上到下由外到内，取最后一个业务帧（最接近抛出点）
        if app_candidates:
            return app_candidates[-1]
        if other_candidates:
            return other_candidates[-1]
        return {}

    for frame in reversed(traceback.extract_stack()[:-1]):
        filename = frame.filename
        if _is_noise(filename):
            continue
        if _is_app_code(filename):
            return {"file": filename, "line": frame.lineno, "functionName": frame.name}

    for frame in reversed(traceback.extract_stack()[:-1]):
        filename = frame.filename
        if _is_noise(filename) or "site-packages" in filename.replace("\\", "/"):
            continue
        return {"file": filename, "line": frame.lineno, "functionName": frame.name}
    return {}


def _safe_extra(data: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in data.items():
        if value is None:
            continue
        if key == "module":
            out["biz_module"] = value
        elif key in _RESERVED:
            out["ctx_{0}".format(key)] = value
        else:
            out[key] = value
    return out


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "level": record.levelname.lower(),
            "message": record.getMessage(),
            "service": "fullstack-infra-backend",
            "logger": record.name,
        }

        biz_module = getattr(record, "biz_module", None)
        if biz_module is not None:
            payload["module"] = biz_module

        for key in (
            "request_id",
            "file",
            "line",
            "column",
            "functionName",
            "stack",
            "path",
            "method",
            "status_code",
            "duration_ms",
            "source",
            "url",
            "userAgent",
            "context",
            "code",
            "details",
            "errorName",
            "errorMessage",
        ):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value

        if record.exc_info and not payload.get("stack"):
            payload["stack"] = "".join(traceback.format_exception(*record.exc_info)).rstrip()

        if payload.get("stack") and not payload.get("file"):
            payload.update(parse_stack_location(payload["stack"]))

        return json.dumps(payload, ensure_ascii=False, default=str)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        file_ = getattr(record, "file", None)
        line_ = getattr(record, "line", None)
        col_ = getattr(record, "column", None)
        loc = ""
        if file_:
            loc = " [{0}".format(file_)
            if line_ is not None:
                loc += ":{0}".format(line_)
            if col_ is not None:
                loc += ":{0}".format(col_)
            loc += "]"

        base = "{0} {1}{2}: {3}".format(ts, record.levelname, loc, record.getMessage())
        stack = getattr(record, "stack", None)
        if record.exc_info and not stack:
            stack = "".join(traceback.format_exception(*record.exc_info)).rstrip()
        if stack:
            base += "\n{0}".format(stack)
        return base


def setup_logging() -> None:
    root = logging.getLogger("app")
    if root.handlers:
        return

    level = getattr(logging, settings.log_level.upper(), logging.DEBUG)
    root.setLevel(level)
    root.propagate = False

    json_formatter = JsonFormatter()

    app_handler = TimedRotatingFileHandler(
        str(LOG_DIR / "app.log"),
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8",
    )
    app_handler.setLevel(level)
    app_handler.setFormatter(json_formatter)
    app_handler.suffix = "%Y-%m-%d"

    error_handler = TimedRotatingFileHandler(
        str(LOG_DIR / "error.log"),
        when="midnight",
        interval=1,
        backupCount=60,
        encoding="utf-8",
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(json_formatter)
    error_handler.suffix = "%Y-%m-%d"

    root.addHandler(app_handler)
    root.addHandler(error_handler)

    if settings.is_dev:
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(level)
        console.setFormatter(ConsoleFormatter())
        root.addHandler(console)

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


class AppLogger:
    """统一日志入口：自动附带 file / line / stack。"""

    def __init__(self, default_extra: Optional[Dict[str, Any]] = None):
        setup_logging()
        self._logger = logging.getLogger("app")
        self._default_extra = default_extra or {}

    def child(self, **extra: Any) -> "AppLogger":
        merged = dict(self._default_extra)
        merged.update(extra)
        return AppLogger(merged)

    def _emit(
        self,
        level: int,
        message: str,
        error: Optional[BaseException] = None,
        stack: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload: Dict[str, Any] = dict(self._default_extra)
        if extra:
            payload.update(extra)

        if error is not None:
            payload.setdefault("errorName", type(error).__name__)
            payload.setdefault("errorMessage", str(error))
            if error.__traceback__ is not None:
                payload.setdefault(
                    "stack",
                    "".join(traceback.format_exception(type(error), error, error.__traceback__)).rstrip(),
                )
            else:
                payload.setdefault(
                    "stack",
                    "".join(traceback.format_exception_only(type(error), error)).rstrip(),
                )

        if stack:
            payload.setdefault("stack", stack)

        if not payload.get("file"):
            loc = parse_stack_location(payload.get("stack"))
            if not loc:
                loc = parse_stack_location()
            for key, value in loc.items():
                if value is not None:
                    payload[key] = value

        self._logger.log(
            level,
            message,
            exc_info=False,
            extra=_safe_extra(payload),
        )

    def debug(self, message: str, **extra: Any) -> None:
        self._emit(logging.DEBUG, message, extra=extra)

    def info(self, message: str, **extra: Any) -> None:
        self._emit(logging.INFO, message, extra=extra)

    def warning(self, message: str, **extra: Any) -> None:
        self._emit(logging.WARNING, message, extra=extra)

    def warn(self, message: str, **extra: Any) -> None:
        self.warning(message, **extra)

    def error(
        self,
        message: str,
        error: Optional[BaseException] = None,
        stack: Optional[str] = None,
        **extra: Any,
    ) -> None:
        self._emit(logging.ERROR, message, error=error, stack=stack, extra=extra)


def get_logger(module: Optional[str] = None, **extra: Any) -> AppLogger:
    data = dict(extra)
    if module:
        data["module"] = module
    return AppLogger(data)


logger = get_logger()

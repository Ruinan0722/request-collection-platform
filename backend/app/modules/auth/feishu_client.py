from __future__ import annotations

import time
from typing import Any, Dict, Optional

import httpx

from app.config.settings import settings
from app.shared.errors import AppError
from app.shared.logger import get_logger

log = get_logger(module="feishu-client")

FEISHU_BASE = "https://open.feishu.cn/open-apis"
_TOKEN_REFRESH_SKEW_SEC = 300

_token_cache: Dict[str, Any] = {"token": "", "expires_at": 0.0}


def get_tenant_access_token() -> str:
    """获取 tenant/app access token（进程内缓存，提前 5 分钟刷新）。"""
    now = time.time()
    token = str(_token_cache.get("token") or "")
    expires_at = float(_token_cache.get("expires_at") or 0)
    if token and now < expires_at:
        return token

    if not settings.feishu_app_id or not settings.feishu_app_secret:
        raise AppError("飞书应用未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                "{0}/auth/v3/app_access_token/internal".format(FEISHU_BASE),
                json={
                    "app_id": settings.feishu_app_id,
                    "app_secret": settings.feishu_app_secret,
                },
            )
            data = resp.json()
    except Exception as exc:
        log.error("获取飞书 tenant token 失败", exc)
        raise AppError("获取飞书凭证失败", status_code=502, code="FEISHU_TOKEN_ERROR") from exc

    if data.get("code") != 0:
        raise AppError(
            "获取飞书凭证失败：{0}".format(data.get("msg") or "unknown"),
            status_code=502,
            code="FEISHU_TOKEN_ERROR",
            details=data,
        )

    access = data.get("tenant_access_token") or data.get("app_access_token")
    if not access:
        raise AppError("飞书未返回 access_token", status_code=502, code="FEISHU_TOKEN_ERROR", details=data)

    expire = int(data.get("expire", 7200))
    _token_cache["token"] = access
    _token_cache["expires_at"] = time.time() + max(expire - _TOKEN_REFRESH_SKEW_SEC, 60)
    return str(access)


def feishu_get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    token = get_tenant_access_token()
    url = path if path.startswith("http") else "{0}{1}".format(FEISHU_BASE, path)
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(
                url,
                params=params,
                headers={"Authorization": "Bearer {0}".format(token)},
            )
            data = resp.json()
    except Exception as exc:
        log.error("飞书 GET 失败", exc, path=path)
        raise AppError("飞书接口请求失败", status_code=502, code="FEISHU_API_ERROR") from exc

    if data.get("code") != 0:
        raise AppError(
            "飞书接口错误：{0}".format(data.get("msg") or "unknown"),
            status_code=502,
            code="FEISHU_API_ERROR",
            details={"path": path, "response": data},
        )
    return data.get("data") or {}


def feishu_post(
    path: str,
    body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    *,
    timeout: float = 15.0,
) -> Dict[str, Any]:
    """飞书 POST；返回 data 字段。失败抛 AppError。"""
    token = get_tenant_access_token()
    url = path if path.startswith("http") else "{0}{1}".format(FEISHU_BASE, path)
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(
                url,
                params=params,
                json=body or {},
                headers={"Authorization": "Bearer {0}".format(token)},
            )
            data = resp.json()
    except Exception as exc:
        log.error("飞书 POST 失败", exc, path=path)
        raise AppError("飞书接口请求失败", status_code=502, code="FEISHU_API_ERROR") from exc

    if data.get("code") != 0:
        raise AppError(
            "飞书接口错误：{0}".format(data.get("msg") or "unknown"),
            status_code=502,
            code="FEISHU_API_ERROR",
            details={"path": path, "response": data},
        )
    return data.get("data") or {}

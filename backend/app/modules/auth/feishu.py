from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx

from app.config.settings import settings
from app.shared.errors import AppError
from app.shared.logger import get_logger

log = get_logger(module="feishu")

# 与 7月6日 geo-api 对齐的基础权限
FEISHU_SCOPES = "contact:user.base:readonly contact:user.department:readonly"


def build_authorize_url(state: str = "", *, redirect_uri: Optional[str] = None) -> str:
    if not settings.feishu_configured:
        raise AppError("飞书登录未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")

    resolved = settings.resolve_feishu_redirect_uri(redirect_uri)
    if not resolved:
        raise AppError("飞书回调地址未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")

    params = {
        "client_id": settings.feishu_app_id,
        "response_type": "code",
        "redirect_uri": resolved,
        "scope": FEISHU_SCOPES,
    }
    if state:
        params["state"] = state
    return "{0}?{1}".format(settings.feishu_auth_url, urlencode(params))


def exchange_code_for_token(code: str, *, redirect_uri: Optional[str] = None) -> Dict[str, Any]:
    resolved = settings.resolve_feishu_redirect_uri(redirect_uri)
    if not resolved:
        raise AppError("飞书回调地址未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")

    payload = {
        "grant_type": "authorization_code",
        "client_id": settings.feishu_app_id,
        "client_secret": settings.feishu_app_secret,
        "code": code,
        "redirect_uri": resolved,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(settings.feishu_token_url, json=payload)
            data = resp.json()
    except Exception as exc:
        log.error("飞书换取 token 失败", exc)
        raise AppError("飞书登录失败：无法换取令牌", status_code=502, code="FEISHU_TOKEN_ERROR") from exc

    if isinstance(data, dict) and data.get("code") not in (None, 0):
        log.error("飞书 token 接口返回错误", errorMessage=str(data))
        raise AppError(
            "飞书登录失败：{0}".format(data.get("error_description") or data.get("msg") or "token error"),
            status_code=502,
            code="FEISHU_TOKEN_ERROR",
            details=data,
        )

    access_token = data.get("access_token")
    if not access_token:
        raise AppError("飞书登录失败：未返回 access_token", status_code=502, code="FEISHU_TOKEN_ERROR", details=data)
    return data


def fetch_user_info(user_access_token: str) -> Dict[str, Any]:
    headers = {
        "Authorization": "Bearer {0}".format(user_access_token),
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(settings.feishu_user_info_url, headers=headers)
            data = resp.json()
    except Exception as exc:
        log.error("获取飞书用户信息失败", exc)
        raise AppError("飞书登录失败：无法获取用户信息", status_code=502, code="FEISHU_USERINFO_ERROR") from exc

    if data.get("code") != 0:
        raise AppError(
            "飞书登录失败：{0}".format(data.get("msg") or "user_info error"),
            status_code=502,
            code="FEISHU_USERINFO_ERROR",
            details=data,
        )

    info = data.get("data") or {}
    open_id = info.get("open_id") or info.get("openId")
    if not open_id:
        raise AppError("飞书登录失败：用户 open_id 缺失", status_code=502, code="FEISHU_USERINFO_ERROR", details=info)

    tenant_key = info.get("tenant_key") or ""
    if settings.feishu_tenant_key and tenant_key and tenant_key != settings.feishu_tenant_key:
        raise AppError("仅本公司飞书账号可登录", status_code=403, code="FEISHU_TENANT_FORBIDDEN")

    return {
        "open_id": open_id,
        "union_id": info.get("union_id") or info.get("unionId"),
        "name": info.get("name") or info.get("en_name") or "飞书用户",
        "avatar_url": info.get("avatar_url") or info.get("avatar_thumb") or info.get("avatar"),
        "email": info.get("email"),
        "tenant_key": tenant_key,
    }

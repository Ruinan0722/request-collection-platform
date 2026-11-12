from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config.settings import settings
from app.modules.auth.contact import resolve_user_org_profile
from app.modules.auth.deps import get_current_user
from app.modules.auth.feishu import build_authorize_url, exchange_code_for_token, fetch_user_info
from app.modules.auth.models import User
from app.modules.auth.org_sync import apply_org_profile_to_user, sync_org_from_roots
from app.modules.auth.dev_users import get_dev_preset, list_dev_presets, preset_open_id
from app.modules.auth.schemas import (
    AuthConfigOut,
    DevLoginIn,
    FeishuCallbackIn,
    LoginResult,
    UpdateRoleIn,
    UserOut,
)
from app.modules.auth.security import create_access_token
from app.shared.database import get_db
from app.shared.errors import AppError, ValidationError
from app.shared.logger import get_logger

log = get_logger(module="auth")
router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        name=user.name,
        role=user.role,  # type: ignore[arg-type]
        avatarUrl=user.avatar_url,
        email=user.email,
        departmentIds=list(user.department_ids or []),
        departmentNames=list(user.department_names or []),
        roleSource=user.role_source or "manual",
        roleLocked=bool(user.role_locked),
    )


def _login_payload(user: User) -> LoginResult:
    token = create_access_token(user.id, extra={"role": user.role, "name": user.name})
    return LoginResult(token=token, user=_user_out(user))


def _pick_redirect_uri(requested: Optional[str]) -> str:
    resolved = settings.resolve_feishu_redirect_uri(requested)
    req = (requested or "").strip()
    if req and req != resolved:
        raise ValidationError(
            "回调地址不在允许列表中，请使用已配置的访问入口登录",
            details={"redirectUri": req, "allowed": settings.feishu_redirect_uri_list},
        )
    return resolved


@router.get("/config", response_model=None)
def auth_config(
    redirect_uri: Optional[str] = Query(None, alias="redirectUri"),
) -> dict:
    authorize_url = None
    if settings.feishu_configured:
        try:
            chosen = _pick_redirect_uri(redirect_uri) if redirect_uri else settings.feishu_redirect_uri_primary
            authorize_url = build_authorize_url(state="feishu_login", redirect_uri=chosen)
        except AppError:
            authorize_url = None
        except ValidationError:
            # 非法 redirectUri 时仍返回配置，但不给 authorizeUrl
            authorize_url = None
    data = AuthConfigOut(
        feishuEnabled=settings.feishu_configured,
        devLoginEnabled=settings.allow_dev_login,
        authorizeUrl=authorize_url,
        devPresets=list_dev_presets() if settings.allow_dev_login else [],
    )
    return {"success": True, "data": data.model_dump()}


def _upsert_dev_user(db: Session, *, name: str, role: str, locked: bool = False) -> User:
    open_id = "dev:{0}:{1}".format(role, name)
    user = db.scalar(select(User).where(User.feishu_open_id == open_id))
    default_dept = ["产品与设计"] if role == "requester" else ["AI效能"]
    if not user:
        user = User(
            id=str(uuid.uuid4()),
            feishu_open_id=open_id,
            name=name,
            role=role,
            role_source="dev",
            role_locked=locked,
            department_names=default_dept,
        )
        db.add(user)
    else:
        user.role = role
        user.name = name
        user.role_source = "dev"
        user.role_locked = locked
        if not user.department_names:
            user.department_names = default_dept
    db.commit()
    db.refresh(user)
    return user


@router.post("/feishu/callback", response_model=None)
def feishu_callback(body: FeishuCallbackIn, db: Session = Depends(get_db)) -> dict:
    if not settings.feishu_configured:
        raise AppError("飞书登录未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")

    redirect_uri = _pick_redirect_uri(body.redirectUri)
    token_data = exchange_code_for_token(body.code, redirect_uri=redirect_uri)
    oauth_profile = fetch_user_info(token_data["access_token"])
    open_id = oauth_profile["open_id"]

    user = db.scalar(select(User).where(User.feishu_open_id == open_id))
    if not user:
        user = User(
            id=str(uuid.uuid4()),
            feishu_open_id=open_id,
            feishu_union_id=oauth_profile.get("union_id"),
            name=oauth_profile["name"],
            avatar_url=oauth_profile.get("avatar_url"),
            email=oauth_profile.get("email"),
            role="requester",
            role_source="feishu",
        )
        db.add(user)
        log.info("飞书新用户注册", open_id=open_id, name=oauth_profile["name"])
    else:
        user.name = oauth_profile["name"] or user.name
        user.avatar_url = oauth_profile.get("avatar_url") or user.avatar_url
        user.email = oauth_profile.get("email") or user.email
        user.feishu_union_id = oauth_profile.get("union_id") or user.feishu_union_id
        log.info("飞书用户登录", user_id=user.id, name=user.name)

    # 通讯录拉部门 → 按部门解析提需/执行身份（对齐 7月6日）
    # 缺 contact 应用权限时 feishu_get 会抛 AppError；开启
    # FEISHU_SKIP_DEPARTMENT_CHECK 时仍应用 OAuth 画像完成登录（便于本地联调）。
    try:
        org_profile = resolve_user_org_profile(open_id)
        # OAuth 画像优先补全展示字段
        if oauth_profile.get("name"):
            org_profile["name"] = oauth_profile["name"]
        if oauth_profile.get("avatar_url"):
            org_profile["avatar_url"] = oauth_profile["avatar_url"]
        if oauth_profile.get("email"):
            org_profile["email"] = oauth_profile["email"]
        apply_org_profile_to_user(db, user, org_profile)
    except RuntimeError as exc:
        db.rollback()
        raise AppError(str(exc), status_code=403, code="DEPARTMENT_NOT_ALLOWED") from exc
    except Exception as exc:
        log.error("解析飞书部门失败", exc, open_id=open_id)
        if settings.feishu_skip_department_check:
            user.role = user.role or "requester"
            user.role_source = "feishu"
            log.warn("部门解析失败，已按跳过校验兜底", open_id=open_id)
        else:
            db.rollback()
            raise AppError(
                "无法获取您的部门信息，请确认飞书通讯录权限或联系管理员",
                status_code=502,
                code="FEISHU_ORG_ERROR",
            ) from exc

    db.commit()
    db.refresh(user)
    log.info(
        "飞书登录完成",
        user_id=user.id,
        role=user.role,
        departments=user.department_names,
    )
    return {"success": True, "data": _login_payload(user).model_dump()}


@router.post("/dev-login", response_model=None)
def dev_login(body: DevLoginIn, db: Session = Depends(get_db)) -> dict:
    if not settings.allow_dev_login:
        raise AppError("开发登录未开启", status_code=403, code="DEV_LOGIN_DISABLED")

    user = _upsert_dev_user(db, name=body.name, role=body.role, locked=False)
    log.info("开发登录", user_id=user.id, role=user.role)
    return {"success": True, "data": _login_payload(user).model_dump()}


@router.post("/dev-login/preset/{key}", response_model=None)
def dev_login_preset(key: str, db: Session = Depends(get_db)) -> dict:
    """一键登录固定测试账号（如需求方测试）。"""
    if not settings.allow_dev_login:
        raise AppError("开发登录未开启", status_code=403, code="DEV_LOGIN_DISABLED")

    preset = get_dev_preset(key)
    if not preset:
        raise ValidationError("未知的测试账号", details={"key": key})

    user = _upsert_dev_user(
        db,
        name=preset["name"],
        role=preset["role"],
        locked=True,
    )
    # 与 seed 使用同一 open_id，便于关联测试数据
    expected = preset_open_id(preset)
    if user.feishu_open_id != expected:
        user.feishu_open_id = expected
        db.commit()
        db.refresh(user)

    log.info("开发预设登录", user_id=user.id, preset=key, role=user.role)
    return {"success": True, "data": _login_payload(user).model_dump()}


@router.get("/me", response_model=None)
def me(user: User = Depends(get_current_user)) -> dict:
    return {"success": True, "data": _user_out(user).model_dump()}


@router.patch("/me/role", response_model=None)
def update_my_role(body: UpdateRoleIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    if body.role not in {"requester", "executor"}:
        raise ValidationError("无效身份")
    if user.role_locked or user.role_source == "feishu":
        raise AppError(
            "身份由飞书部门自动判定，不可手动切换",
            status_code=403,
            code="ROLE_LOCKED",
        )
    user.role = body.role
    user.role_source = "manual"
    db.commit()
    db.refresh(user)
    return {"success": True, "data": _user_out(user).model_dump()}


@router.get("/users", response_model=None)
def list_users(
    role: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _ = user
    stmt = select(User).order_by(User.created_at.desc())
    if role in {"requester", "executor"}:
        stmt = stmt.where(User.role == role)
    rows = db.scalars(stmt).all()
    return {"success": True, "data": [_user_out(u).model_dump() for u in rows]}


@router.post("/org/sync", response_model=None)
def trigger_org_sync(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """手动触发组织同步（管理员 open_id 或开发环境）。"""
    from app.modules.auth.role_resolver import is_admin_open_id

    if not (settings.is_dev or is_admin_open_id(user.feishu_open_id or "")):
        raise AppError("无权限同步组织", status_code=403, code="FORBIDDEN")
    if not settings.feishu_configured:
        raise AppError("飞书未配置", status_code=503, code="FEISHU_NOT_CONFIGURED")
    result = sync_org_from_roots(db)
    return {"success": True, "data": result}

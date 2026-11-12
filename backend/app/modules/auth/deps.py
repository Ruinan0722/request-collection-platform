from __future__ import annotations

from typing import Generator, Optional

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.modules.auth.models import User
from app.modules.auth.security import decode_access_token
from app.shared.database import get_db
from app.shared.errors import AppError


def get_bearer_token(authorization: Optional[str] = Header(default=None)) -> str:
    if not authorization:
        raise AppError("未登录", status_code=401, code="UNAUTHORIZED")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise AppError("无效的 Authorization 头", status_code=401, code="UNAUTHORIZED")
    return parts[1].strip()


def get_current_user(
    token: str = Depends(get_bearer_token),
    db: Session = Depends(get_db),
) -> User:
    payload = decode_access_token(token)
    user_id = payload.get("sub")
    if not user_id:
        raise AppError("无效的登录凭证", status_code=401, code="INVALID_TOKEN")

    user = db.get(User, user_id)
    if not user:
        raise AppError("用户不存在或已失效", status_code=401, code="USER_NOT_FOUND")
    return user


def require_roles(*roles: str):
    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise AppError("当前身份无权执行此操作", status_code=403, code="FORBIDDEN")
        return user

    return _dep


def get_optional_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> Optional[User]:
    if not authorization:
        return None
    try:
        token = get_bearer_token(authorization)
        return get_current_user(token, db)
    except AppError:
        return None

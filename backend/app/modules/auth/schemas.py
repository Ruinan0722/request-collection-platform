from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


RoleType = Literal["requester", "executor"]


class UserOut(BaseModel):
    id: str
    name: str
    role: RoleType
    avatarUrl: Optional[str] = None
    email: Optional[str] = None
    departmentIds: List[str] = Field(default_factory=list)
    departmentNames: List[str] = Field(default_factory=list)
    roleSource: str = "manual"
    roleLocked: bool = False

    class Config:
        from_attributes = True


class AuthConfigOut(BaseModel):
    feishuEnabled: bool
    devLoginEnabled: bool
    authorizeUrl: Optional[str] = None
    devPresets: List[dict] = Field(default_factory=list)


class FeishuCallbackIn(BaseModel):
    code: str = Field(min_length=1)
    state: Optional[str] = None
    # 须与发起授权时的 redirect_uri 一致；须在 FEISHU_REDIRECT_URI 白名单内
    redirectUri: Optional[str] = None


class DevLoginIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    role: RoleType = "requester"


class LoginResult(BaseModel):
    token: str
    user: UserOut


class UpdateRoleIn(BaseModel):
    role: RoleType

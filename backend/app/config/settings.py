from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _parse_csv(raw: str) -> List[str]:
    return [s.strip() for s in (raw or "").split(",") if s.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = f"sqlite:///{BACKEND_ROOT / 'data' / 'req-platform.sqlite3'}"
    backend_port: int = 17864
    app_env: str = "development"
    log_level: str = "DEBUG"
    cors_origin: str = "http://localhost:17863"

    jwt_secret: str = "change-me-in-production"
    jwt_expire_hours: int = 24
    # 需求附件本地目录（相对 backend 根目录或绝对路径）
    upload_dir: str = "uploads"

    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_redirect_uri: str = "http://localhost:17863/auth/callback"
    feishu_auth_url: str = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
    feishu_token_url: str = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
    feishu_user_info_url: str = "https://open.feishu.cn/open-apis/authen/v1/user_info"
    feishu_tenant_key: str = ""

    # 部门 → 身份：CSV 可配多个执行方部门（当前仅 AI效能）；展示归属见 executor_orgs
    feishu_requester_departments: str = ""
    feishu_executor_departments: str = "AI效能"
    feishu_requester_department_ids: str = ""
    feishu_executor_department_ids: str = ""
    # 个别跨部门执行人员的飞书 open_id 白名单（CSV），优先于部门规则。
    feishu_executor_open_ids: str = ""
    feishu_org_root_department_ids: str = ""
    admin_feishu_open_ids: str = ""
    feishu_skip_department_check: bool = True
    feishu_org_sync_on_startup: bool = False
    # 可选：指向 7月6日 geo-admin/config/feishu-department-map.json 等完整映射
    feishu_department_map_path: str = ""

    # 飞书机器人通知：新建 / 验收完成 → 负责人；进入验收 → 提需人
    feishu_notify_enabled: bool = False
    # open_ids | assignees | executors
    feishu_notify_owner_mode: str = "open_ids"
    feishu_notify_owner_open_ids: str = ""
    # 飞书消息「查看详情」链接根地址；局域网/生产勿用 localhost
    public_app_url: str = ""

    auth_dev_mode: Optional[bool] = None

    @property
    def is_dev(self) -> bool:
        return self.app_env.lower() in {"development", "dev", "local"}

    @property
    def feishu_configured(self) -> bool:
        return bool(self.feishu_app_id and self.feishu_app_secret and self.feishu_redirect_uri_list)

    @property
    def feishu_redirect_uri_list(self) -> List[str]:
        """允许的 OAuth 回调地址（CSV）；授权与换 token 必须用同一条。"""
        return _parse_csv(self.feishu_redirect_uri)

    @property
    def feishu_redirect_uri_primary(self) -> str:
        uris = self.feishu_redirect_uri_list
        return uris[0] if uris else ""

    def resolve_feishu_redirect_uri(self, requested: Optional[str] = None) -> str:
        allowed = self.feishu_redirect_uri_list
        if not allowed:
            return ""
        req = (requested or "").strip()
        if req and req in allowed:
            return req
        return allowed[0]

    @property
    def allow_dev_login(self) -> bool:
        if self.auth_dev_mode is not None:
            return bool(self.auth_dev_mode)
        return self.is_dev and not self.feishu_configured

    @property
    def admin_open_id_list(self) -> List[str]:
        return _parse_csv(self.admin_feishu_open_ids)

    @property
    def notify_owner_open_id_list(self) -> List[str]:
        return _parse_csv(self.feishu_notify_owner_open_ids)

    @property
    def public_app_base_url(self) -> str:
        """前端根地址，用于飞书消息深链（优先 PUBLIC_APP_URL）。"""
        return (self.public_app_url or self.cors_origin or "").rstrip("/")

    @property
    def requester_department_id_list(self) -> List[str]:
        return _parse_csv(self.feishu_requester_department_ids)

    @property
    def executor_department_id_list(self) -> List[str]:
        return _parse_csv(self.feishu_executor_department_ids)

    @property
    def executor_open_id_list(self) -> List[str]:
        return _parse_csv(self.feishu_executor_open_ids)

    @property
    def org_root_department_id_list(self) -> List[str]:
        roots = _parse_csv(self.feishu_org_root_department_ids)
        if roots:
            return roots
        return list(
            dict.fromkeys(self.requester_department_id_list + self.executor_department_id_list)
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

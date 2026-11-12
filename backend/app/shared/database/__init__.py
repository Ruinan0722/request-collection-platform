from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Generator

from sqlalchemy import create_engine, event, inspect, select
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config.settings import settings
from app.shared.logger import get_logger

log = get_logger(module="database")


class Base(DeclarativeBase):
    pass


if not settings.database_url.startswith("sqlite:"):
    raise RuntimeError("需求收集平台仅支持 SQLite；请将 DATABASE_URL 配置为 sqlite:///...")

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_pre_ping=True,
    echo=False,
)


@event.listens_for(engine, "connect")
def _configure_sqlite(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_database() -> None:
    """初始化 SQLite 表结构，并兼容升级早期 SQLite 开发库。"""
    from app.modules.auth import models as _auth_models  # noqa: F401
    from app.modules.client_logs import models as _client_logs_models  # noqa: F401
    from app.modules.health import models as _health_models  # noqa: F401
    from app.modules.projects import models as _projects_models  # noqa: F401
    from app.modules.requirements import models as _requirements_models  # noqa: F401

    try:
        database_path = engine.url.database
        if database_path and database_path != ":memory:":
            from pathlib import Path

            Path(database_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)

        Base.metadata.create_all(bind=engine)
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
            # 旧状态迁移
            conn.exec_driver_sql("UPDATE requirements SET status = 'waiting_impl' WHERE status = 'todo'")
            conn.exec_driver_sql("UPDATE requirements SET status = 'implementing' WHERE status = 'doing'")
            # 已取消双重身份：历史 both 归为提需求方
            conn.exec_driver_sql("UPDATE users SET role = 'requester' WHERE role = 'both'")
            # 仅为旧 SQLite 开发库补列；正式结构演进应在发版前完成并保持向后兼容。
            existing = {
                table: {column["name"] for column in inspect(conn).get_columns(table)}
                for table in ("users", "requirements")
            }
            additions = {
                "users": {
                    "role_source": "VARCHAR(32) DEFAULT 'manual'",
                    "role_locked": "BOOLEAN DEFAULT 0",
                    "department_ids": "JSON",
                    "department_names": "JSON",
                },
                "requirements": {
                    "due_date": "DATETIME",
                    "claimed_at": "DATETIME",
                    "wont_reason": "TEXT",
                    "after_impl": "TEXT",
                    "impl_value": "TEXT",
                    "efficiency_gain": "TEXT",
                    "expected_level": "VARCHAR(16) DEFAULT 'unset'",
                },
            }
            for table, columns in additions.items():
                for name, sql_type in columns.items():
                    if name not in existing[table]:
                        conn.exec_driver_sql(
                            f'ALTER TABLE "{table}" ADD COLUMN "{name}" {sql_type}'
                        )
            conn.commit()

        # 为已有需求回填首条状态历史（仅缺历史时）
        from app.modules.requirements.models import Requirement, RequirementStatusHistory

        with SessionLocal() as db:
            existing_ids = set(db.scalars(select(RequirementStatusHistory.requirement_id)).all())
            reqs = db.scalars(select(Requirement)).all()
            for req in reqs:
                if req.id in existing_ids:
                    continue
                entered = req.created_at or datetime.now(timezone.utc)
                if entered.tzinfo is None:
                    entered = entered.replace(tzinfo=timezone.utc)
                db.add(
                    RequirementStatusHistory(
                        id=str(uuid.uuid4()),
                        requirement_id=req.id,
                        status=req.status or "evaluating",
                        entered_at=entered,
                        actor_id=req.requester_id,
                    )
                )
            db.commit()

        log.info("数据库连接成功，表结构已同步")
    except Exception as exc:
        log.error("数据库初始化失败", exc)
        raise

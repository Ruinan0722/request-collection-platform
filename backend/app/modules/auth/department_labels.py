"""部门 open_department_id → 中文名（飞书未返回 name 时的兜底）。

飞书应用需开通 contact:department.base:readonly 才能从 API 直接拿到部门名；
此前用 config/feishu-department-labels.json 与可选 FEISHU_DEPARTMENT_MAP_PATH 兜底。
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Dict, Optional

from app.config.settings import settings

_STRIP_SUFFIX = re.compile(r"（[^）]*）$")
_BACKEND_ROOT = Path(__file__).resolve().parents[3]


def _short_label(raw: str) -> str:
    trimmed = (raw or "").strip()
    if not trimmed:
        return ""
    if ">" in trimmed:
        trimmed = trimmed.split(">")[-1].strip()
    return _STRIP_SUFFIX.sub("", trimmed).strip()


def _load_json_labels(path: Path) -> Dict[str, str]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}

    labels: Dict[str, str] = {}
    if "labels" in data and isinstance(data["labels"], dict):
        source = data["labels"]
    else:
        source = data
    for dept_id, label in source.items():
        if isinstance(dept_id, str) and dept_id.startswith("od-") and isinstance(label, str):
            short = _short_label(label)
            if short:
                labels[dept_id] = short

    # roles: 名称 → id，反转为 id → 名称（仅当 labels 缺失时）
    roles = data.get("roles")
    if isinstance(roles, dict):
        for name, dept_id in roles.items():
            if isinstance(name, str) and isinstance(dept_id, str) and dept_id.startswith("od-"):
                labels.setdefault(dept_id, name.strip())
    return labels


@lru_cache
def get_department_id_labels() -> Dict[str, str]:
    merged: Dict[str, str] = {}
    merged.update(_load_json_labels(_BACKEND_ROOT / "config" / "feishu-department-labels.json"))
    map_path = (settings.feishu_department_map_path or "").strip()
    if map_path:
        merged.update(_load_json_labels(Path(map_path)))
    return merged


def resolve_department_name(dept_id: str) -> Optional[str]:
    return get_department_id_labels().get(dept_id)

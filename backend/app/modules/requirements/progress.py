"""需求进度节点定义（前后端共用语义）。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

# 主流程节点（线性）：从评优先级开始，无「待整理」
PROGRESS_NODES: List[Tuple[str, str]] = [
    ("evaluating", "待评优先级"),
    ("waiting_impl", "等待实现"),
    ("implementing", "实现中"),
    ("pending_accept", "已实现等待验收"),
    ("done", "已验收完成"),
]

# 旁路终态
SIDE_STATUSES: Dict[str, str] = {
    "wont_impl": "无法实现",
}

STATUS_LABEL: Dict[str, str] = {code: label for code, label in PROGRESS_NODES}
STATUS_LABEL.update(SIDE_STATUSES)

# 工作台汇总桶：待做 / 正在做 / 已实现 / 无法实现
DASHBOARD_BUCKETS: List[Tuple[str, str, Tuple[str, ...]]] = [
    ("todo", "待做", ("evaluating", "waiting_impl")),
    ("doing", "正在做", ("implementing",)),
    ("done", "已实现", ("pending_accept", "done")),
    ("wont", "无法实现", ("wont_impl",)),
]

# 兼容旧状态
STATUS_ALIASES: Dict[str, str] = {
    "backlog": "evaluating",  # 已取消「待整理」，归入评优先级
    "todo": "waiting_impl",
    "doing": "implementing",
}

VALID_STATUSES = set(STATUS_LABEL.keys()) | set(STATUS_ALIASES.keys())


def normalize_status(status: str) -> str:
    return STATUS_ALIASES.get(status, status)


def status_filter_values(status: str) -> List[str]:
    """查询时同时匹配规范状态及其历史别名。"""
    normalized = normalize_status(status)
    aliases = [k for k, v in STATUS_ALIASES.items() if v == normalized]
    return list({normalized, *aliases, status})


def progress_index(status: str) -> int:
    code = normalize_status(status)
    for idx, (node_code, _) in enumerate(PROGRESS_NODES):
        if node_code == code:
            return idx
    return 0


def format_duration_minutes(minutes: Optional[int]) -> Optional[str]:
    """仅按分钟展示，不涉及秒。"""
    if minutes is None:
        return None
    total = int(max(0, minutes))
    if total < 1:
        return "<1分钟"
    if total < 60:
        return f"{total}分钟"
    hours = total // 60
    rem_m = total % 60
    if hours < 48:
        return f"{hours}小时{rem_m}分" if rem_m else f"{hours}小时"
    days = hours // 24
    rem_h = hours % 24
    return f"{days}天{rem_h}小时" if rem_h else f"{days}天"


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _ensure_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _node_timing(
    code: str,
    history: Sequence[object],
    *,
    current: str,
    now: datetime,
) -> Dict[str, Optional[object]]:
    """根据进入历史推算某节点的进入/离开时间与耗时（分钟）。"""
    events = sorted(
        (
            {
                "status": normalize_status(getattr(h, "status")),
                "entered_at": _ensure_aware(getattr(h, "entered_at")),
            }
            for h in history
            if getattr(h, "entered_at", None) is not None
        ),
        key=lambda e: e["entered_at"],
    )
    entered: Optional[datetime] = None
    for event in events:
        if event["status"] == code:
            entered = event["entered_at"]
            break
    if not entered:
        return {
            "enteredAt": None,
            "leftAt": None,
            "durationMinutes": None,
            "durationLabel": None,
        }

    left: Optional[datetime] = None
    for event in events:
        if event["entered_at"] > entered and event["status"] != code:
            left = event["entered_at"]
            break

    end = left
    if end is None and code == current:
        end = now

    duration_minutes: Optional[int] = None
    if end is not None:
        # 向下取整到分钟；不足 1 分钟记为 0，展示为 <1分钟
        duration_minutes = int(max(0, (end - entered).total_seconds()) // 60)

    return {
        "enteredAt": _iso(entered),
        "leftAt": _iso(left),
        "durationMinutes": duration_minutes,
        "durationLabel": format_duration_minutes(duration_minutes),
    }


def build_progress_nodes(
    current_status: str,
    history: Optional[Sequence[object]] = None,
    now: Optional[datetime] = None,
) -> List[dict]:
    current = normalize_status(current_status)
    now = now or datetime.now(timezone.utc)
    history = history or []

    # 无法实现为旁路终态：时间轴只展示该节点
    if current == "wont_impl":
        timing = _node_timing("wont_impl", history, current=current, now=now)
        return [
            {
                "code": "wont_impl",
                "label": "无法实现",
                "state": "current",
                **timing,
            }
        ]

    current_idx = progress_index(current)
    nodes = []
    for idx, (code, label) in enumerate(PROGRESS_NODES):
        if idx < current_idx:
            state = "done"
        elif idx == current_idx:
            state = "current"
        else:
            state = "pending"
        timing = _node_timing(code, history, current=current, now=now) if state != "pending" else {
            "enteredAt": None,
            "leftAt": None,
            "durationMinutes": None,
            "durationLabel": None,
        }
        nodes.append({"code": code, "label": label, "state": state, **timing})
    return nodes


def dashboard_bucket(status: str) -> str:
    code = normalize_status(status)
    for bucket_code, _label, statuses in DASHBOARD_BUCKETS:
        if code in statuses:
            return bucket_code
    return "todo"


# 优先级越高数字越小，用于看板/工作台排序
PRIORITY_RANK: Dict[str, int] = {
    "p0": 0,
    "p1": 1,
    "p2": 2,
    "p3": 3,
    "unset": 4,
}


def priority_rank(priority: Optional[str]) -> int:
    return PRIORITY_RANK.get((priority or "unset").lower(), 99)

"""各部门提需 / 解决统计（工作台与周报导出）。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.auth.models import User
from app.modules.requirements.models import Requirement, RequirementStatusHistory
from app.modules.requirements.progress import STATUS_LABEL, normalize_status

# 已实现等待验收 + 已验收完成，计为「已解决」
SOLVED_STATUSES = frozenset({"pending_accept", "done"})
BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


def is_solved_status(status: Optional[str]) -> bool:
    return normalize_status(status or "") in SOLVED_STATUSES


def parse_department_label(raw: Optional[str]) -> str:
    """从结构化描述或用户部门字段解析主属部门名。"""
    text = (raw or "").strip()
    if not text:
        return "未绑定部门"
    # 多部门用 · 连接时取第一段作为主属部门
    primary = text.split(" · ")[0].strip()
    return primary or "未绑定部门"


def department_of_requirement(item: dict, requester: Optional[User]) -> str:
    """需求归属提需部门：优先描述中的【部门】，否则提需人主部门。"""
    description = (item.get("description") or "").strip()
    if description:
        marker = "【部门】"
        if marker in description:
            rest = description.split(marker, 1)[1]
            line = rest.split("\n", 1)[0].strip()
            if line:
                return parse_department_label(line)

    if requester and requester.department_names:
        names = [str(n).strip() for n in requester.department_names if str(n).strip()]
        if names:
            return parse_department_label(names[0] if len(names) == 1 else " · ".join(names))
    return "未绑定部门"


def department_of_orm(req: Requirement, requester: Optional[User]) -> str:
    return department_of_requirement(
        {"description": req.description, "requesterId": req.requester_id},
        requester,
    )


def week_bounds(
    *,
    from_day: Optional[str] = None,
    to_day: Optional[str] = None,
    now: Optional[datetime] = None,
) -> Tuple[datetime, datetime, str, str]:
    """
    返回 [start, end) UTC 边界，以及业务日 YYYY-MM-DD。
    默认近 7 个自然日（含今天），按 Asia/Shanghai。
    """
    local_now = (now or datetime.now(timezone.utc)).astimezone(BUSINESS_TZ)

    def _parse_day(raw: str, *, end: bool) -> datetime:
        day = datetime.strptime(raw.strip(), "%Y-%m-%d").replace(tzinfo=BUSINESS_TZ)
        if end:
            return day + timedelta(days=1)
        return day

    if from_day and to_day:
        start_local = _parse_day(from_day, end=False)
        end_local = _parse_day(to_day, end=True)
    elif from_day:
        start_local = _parse_day(from_day, end=False)
        end_local = start_local + timedelta(days=7)
    elif to_day:
        end_local = _parse_day(to_day, end=True)
        start_local = end_local - timedelta(days=7)
    else:
        today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        end_local = today + timedelta(days=1)
        start_local = today - timedelta(days=6)

    if end_local <= start_local:
        end_local = start_local + timedelta(days=1)

    from_label = start_local.date().isoformat()
    to_label = (end_local - timedelta(days=1)).date().isoformat()
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc), from_label, to_label


def aggregate_department_counts(
    items: Iterable[dict],
    users: Dict[str, User],
) -> List[dict]:
    """全量：各部门提出数 / 已解决数。"""
    submitted: Dict[str, int] = {}
    solved: Dict[str, int] = {}
    for item in items:
        dept = department_of_requirement(item, users.get(str(item.get("requesterId") or "")))
        submitted[dept] = submitted.get(dept, 0) + 1
        if is_solved_status(item.get("status")):
            solved[dept] = solved.get(dept, 0) + 1

    total = sum(submitted.values())
    rows = [
        {
            "name": name,
            "count": submitted[name],
            "submitted": submitted[name],
            "solved": solved.get(name, 0),
            "ratio": round(submitted[name] / total, 4) if total else 0,
        }
        for name in submitted
    ]
    rows.sort(key=lambda row: (-row["submitted"], row["name"]))
    return rows


def _load_users(db: Session, user_ids: Iterable[str]) -> Dict[str, User]:
    ids = {uid for uid in user_ids if uid}
    if not ids:
        return {}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids))).all()}


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _req_brief(req: Requirement, *, project_name: Optional[str] = None) -> dict:
    status = normalize_status(req.status)
    title = (req.title or "").strip() or "未命名需求"
    if title.startswith("[测试]"):
        title = title[len("[测试]") :]
    return {
        "id": req.id,
        "title": title,
        "status": status,
        "statusLabel": STATUS_LABEL.get(status, status),
        "projectName": project_name,
        "priority": req.priority or "unset",
    }


def weekly_department_stats(
    db: Session,
    *,
    start: datetime,
    end: datetime,
    with_items: bool = True,
) -> List[dict]:
    """
    一周内：
    - submitted：created_at 落在区间内
    - solved：首次进入「已解决」状态的时间落在区间内
    - submittedItems / solvedItems：对应需求明细（标题、状态等）
    """
    from app.modules.projects.models import Project

    reqs = db.scalars(select(Requirement)).all()
    if not reqs:
        return []

    users = _load_users(db, (r.requester_id for r in reqs))
    req_by_id = {r.id: r for r in reqs}
    project_ids = {r.project_id for r in reqs if r.project_id}
    projects = {
        p.id: p
        for p in db.scalars(select(Project).where(Project.id.in_(project_ids))).all()
    } if project_ids else {}

    submitted_items: Dict[str, List[dict]] = {}
    for req in reqs:
        created = _aware(req.created_at)
        if created is None or not (start <= created < end):
            continue
        dept = department_of_orm(req, users.get(req.requester_id))
        project = projects.get(req.project_id)
        project_name = project.name if project else None
        if project_name and project_name.startswith("[测试]"):
            project_name = project_name[len("[测试]") :]
        submitted_items.setdefault(dept, []).append(
            _req_brief(req, project_name=project_name)
        )

    all_solved_hist = db.scalars(
        select(RequirementStatusHistory)
        .where(RequirementStatusHistory.status.in_(tuple(SOLVED_STATUSES)))
        .order_by(RequirementStatusHistory.entered_at.asc())
    ).all()

    first_solved_at: Dict[str, datetime] = {}
    for row in all_solved_hist:
        if normalize_status(row.status) not in SOLVED_STATUSES:
            continue
        if row.requirement_id in first_solved_at:
            continue
        entered = _aware(row.entered_at)
        if entered is None:
            continue
        first_solved_at[row.requirement_id] = entered

    solved_items: Dict[str, List[dict]] = {}
    counted: set[str] = set()
    for req_id, entered in first_solved_at.items():
        if not (start <= entered < end):
            continue
        req = req_by_id.get(req_id)
        if not req:
            continue
        counted.add(req_id)
        dept = department_of_orm(req, users.get(req.requester_id))
        project = projects.get(req.project_id)
        project_name = project.name if project else None
        if project_name and project_name.startswith("[测试]"):
            project_name = project_name[len("[测试]") :]
        solved_items.setdefault(dept, []).append(
            _req_brief(req, project_name=project_name)
        )

    for req in reqs:
        if req.id in counted or req.id in first_solved_at:
            continue
        if not is_solved_status(req.status):
            continue
        updated = _aware(req.updated_at or req.created_at)
        if updated is None or not (start <= updated < end):
            continue
        dept = department_of_orm(req, users.get(req.requester_id))
        project = projects.get(req.project_id)
        project_name = project.name if project else None
        if project_name and project_name.startswith("[测试]"):
            project_name = project_name[len("[测试]") :]
        solved_items.setdefault(dept, []).append(
            _req_brief(req, project_name=project_name)
        )

    # 同部门内按标题排序，便于阅读
    for bucket in (submitted_items, solved_items):
        for dept, items in bucket.items():
            items.sort(key=lambda i: (i.get("title") or "", i.get("id") or ""))

    names = sorted(
        set(submitted_items) | set(solved_items),
        key=lambda n: (
            -(len(submitted_items.get(n, [])) + len(solved_items.get(n, []))),
            n,
        ),
    )
    rows: List[dict] = []
    for name in names:
        sub_list = submitted_items.get(name, [])
        sol_list = solved_items.get(name, [])
        if not sub_list and not sol_list:
            continue
        row = {
            "name": name,
            "submitted": len(sub_list),
            "solved": len(sol_list),
        }
        if with_items:
            row["submittedItems"] = sub_list
            row["solvedItems"] = sol_list
        rows.append(row)
    return rows


def weekly_export_filename(*, from_label: str, to_label: str, ext: str = "pdf") -> str:
    """导出文件名：部门需求周报_起始_至_结束.pdf"""
    return f"部门需求周报_{from_label}_至_{to_label}.{ext}"


def _resolve_cn_font_path() -> str:
    candidates = [
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    from pathlib import Path

    for path in candidates:
        if Path(path).is_file():
            return path
    raise FileNotFoundError(
        "未找到可用中文字体，请安装 fonts-wqy-zenhei 或配置系统中文字体"
    )


def build_weekly_pdf(rows: List[dict], *, from_label: str, to_label: str) -> bytes:
    """按工作台「本周部门统计」区块样式生成 PDF。"""
    from io import BytesIO

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        KeepTogether,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    font_path = _resolve_cn_font_path()
    font_name = "ReqCN"
    try:
        pdfmetrics.registerFont(TTFont(font_name, font_path, subfontIndex=0))
    except Exception:
        pdfmetrics.registerFont(TTFont(font_name, font_path))

    # 与前端 CSS 变量对齐
    ink = colors.HexColor("#141c2b")
    muted = colors.HexColor("#6b778f")
    line = colors.HexColor("#d7dce6")
    panel = colors.white
    accent_ink = colors.HexColor("#1e3fd6")
    solved = colors.HexColor("#1f6b45")
    page_bg_hint = colors.HexColor("#f5f7fb")

    submitted_total = sum(int(r.get("submitted") or 0) for r in rows)
    solved_total = sum(int(r.get("solved") or 0) for r in rows)

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=f"本周部门统计 {from_label} ~ {to_label}",
        author="需求收集平台",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "WeeklyTitle",
        parent=styles["Title"],
        fontName=font_name,
        fontSize=20,
        textColor=ink,
        alignment=TA_LEFT,
        spaceAfter=4,
        leading=26,
    )
    lead_style = ParagraphStyle(
        "WeeklyLead",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=10,
        textColor=muted,
        alignment=TA_LEFT,
        spaceAfter=14,
        leading=15,
    )
    card_label = ParagraphStyle(
        "CardLabel",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9,
        textColor=muted,
        alignment=TA_LEFT,
        leading=12,
    )
    card_value = ParagraphStyle(
        "CardValue",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=22,
        textColor=accent_ink,
        alignment=TA_LEFT,
        leading=28,
        spaceBefore=2,
    )
    card_value_solved = ParagraphStyle(
        "CardValueSolved",
        parent=card_value,
        textColor=solved,
    )
    th_style = ParagraphStyle(
        "ThCN",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9,
        textColor=muted,
        alignment=TA_LEFT,
        leading=12,
    )
    th_right = ParagraphStyle("ThRight", parent=th_style, alignment=TA_RIGHT)
    td_style = ParagraphStyle(
        "TdCN",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=10,
        textColor=ink,
        alignment=TA_LEFT,
        leading=14,
    )
    td_right = ParagraphStyle("TdRight", parent=td_style, alignment=TA_RIGHT)
    td_right_bold = ParagraphStyle(
        "TdRightBold",
        parent=td_right,
        fontName=font_name,
    )
    foot_style = ParagraphStyle(
        "FootCN",
        parent=td_style,
        fontName=font_name,
    )
    note_style = ParagraphStyle(
        "NoteCN",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=8.5,
        textColor=muted,
        alignment=TA_LEFT,
        leading=13,
    )

    story = [
        Paragraph("本周部门统计", title_style),
        Paragraph(
            f"{from_label} ~ {to_label}：各部门新建需求数，以及本周首次解决的需求数。",
            lead_style,
        ),
    ]

    # 两个汇总卡片（对齐 .home-weekly-summary）
    card_submitted = Table(
        [
            [Paragraph("本周提出", card_label)],
            [Paragraph(str(submitted_total), card_value)],
        ],
        colWidths=[82 * mm],
    )
    card_submitted.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), panel),
                ("BOX", (0, 0), (-1, -1), 0.8, line),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, 0), 10),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 12),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    card_solved = Table(
        [
            [Paragraph("本周解决", card_label)],
            [Paragraph(str(solved_total), card_value_solved)],
        ],
        colWidths=[82 * mm],
    )
    card_solved.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), panel),
                ("BOX", (0, 0), (-1, -1), 0.8, line),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, 0), 10),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 12),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    summary = Table([[card_submitted, card_solved]], colWidths=[88 * mm, 88 * mm])
    summary.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 6),
                ("LEFTPADDING", (1, 0), (1, 0), 6),
                ("RIGHTPADDING", (1, 0), (1, 0), 0),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(summary)
    story.append(Spacer(1, 12))

    # 明细表（对齐 .data-table.home-weekly-table：浅色表头、右对齐数字、合计加粗顶线）
    table_data = [
        [
            Paragraph("部门", th_style),
            Paragraph("本周提出", th_right),
            Paragraph("本周解决", th_right),
        ]
    ]
    for row in rows:
        name = str(row.get("name") or "未绑定部门")
        sub = int(row.get("submitted") or 0)
        sol = int(row.get("solved") or 0)
        table_data.append(
            [
                Paragraph(name, td_style),
                Paragraph(str(sub), td_right),
                Paragraph(str(sol), td_right),
            ]
        )
    table_data.append(
        [
            Paragraph("<b>合计</b>", foot_style),
            Paragraph(f"<b>{submitted_total}</b>", td_right_bold),
            Paragraph(f"<b>{solved_total}</b>", td_right_bold),
        ]
    )

    detail = Table(table_data, colWidths=[100 * mm, 38 * mm, 38 * mm], repeatRows=1)
    detail_style = [
        ("BACKGROUND", (0, 0), (-1, 0), page_bg_hint),
        ("BACKGROUND", (0, 1), (-1, -1), panel),
        ("FONTNAME", (0, 0), (-1, -1), font_name),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("LINEBELOW", (0, 0), (-1, -2), 0.6, line),
        ("LINEABOVE", (0, -1), (-1, -1), 1.0, line),
        ("BOX", (0, 0), (-1, -1), 0.8, line),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]
    detail.setStyle(TableStyle(detail_style))
    story.append(KeepTogether([detail]))
    story.append(Spacer(1, 14))

    # 各部门需求明细（具体功能 / 标题）
    section_title = ParagraphStyle(
        "DeptSection",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=13,
        textColor=ink,
        alignment=TA_LEFT,
        spaceBefore=10,
        spaceAfter=6,
        leading=18,
    )
    group_label = ParagraphStyle(
        "GroupLabel",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=10,
        textColor=accent_ink,
        alignment=TA_LEFT,
        spaceBefore=4,
        spaceAfter=4,
        leading=14,
    )
    item_title = ParagraphStyle(
        "ItemTitle",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9.5,
        textColor=ink,
        alignment=TA_LEFT,
        leading=13,
    )
    item_meta = ParagraphStyle(
        "ItemMeta",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=8.5,
        textColor=muted,
        alignment=TA_LEFT,
        leading=12,
    )
    empty_hint = ParagraphStyle(
        "EmptyHint",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=9,
        textColor=muted,
        alignment=TA_LEFT,
        leading=12,
        spaceAfter=4,
    )

    story.append(Paragraph("各部门需求明细", section_title))
    story.append(
        Paragraph(
            "以下按部门列出本周提出与解决的具体需求（功能标题）。",
            lead_style,
        )
    )

    def _items_table(items: List[dict], kind: str) -> Table:
        header = [
            Paragraph("序号", th_style),
            Paragraph("需求 / 功能", th_style),
            Paragraph("状态", th_right),
            Paragraph("项目", th_right),
        ]
        data = [header]
        for idx, item in enumerate(items, start=1):
            title = str(item.get("title") or "未命名需求")
            status_label = str(item.get("statusLabel") or item.get("status") or "-")
            project_name = str(item.get("projectName") or "-")
            data.append(
                [
                    Paragraph(str(idx), td_style),
                    Paragraph(title, item_title),
                    Paragraph(status_label, td_right),
                    Paragraph(project_name, item_meta),
                ]
            )
        table = Table(data, colWidths=[12 * mm, 88 * mm, 36 * mm, 40 * mm], repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), page_bg_hint),
                    ("BACKGROUND", (0, 1), (-1, -1), panel),
                    ("FONTNAME", (0, 0), (-1, -1), font_name),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("LINEBELOW", (0, 0), (-1, -2), 0.5, line),
                    ("BOX", (0, 0), (-1, -1), 0.7, line),
                    ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
                ]
            )
        )
        return table

    for row in rows:
        dept_name = str(row.get("name") or "未绑定部门")
        submitted_items = list(row.get("submittedItems") or [])
        solved_items = list(row.get("solvedItems") or [])
        block: List = [
            Paragraph(
                f"{dept_name}（提出 {int(row.get('submitted') or 0)} · 解决 {int(row.get('solved') or 0)}）",
                section_title,
            )
        ]
        block.append(Paragraph("本周提出", group_label))
        if submitted_items:
            block.append(_items_table(submitted_items, "submitted"))
        else:
            block.append(Paragraph("本周暂无新建需求", empty_hint))
        block.append(Spacer(1, 6))
        block.append(Paragraph("本周解决", group_label))
        if solved_items:
            block.append(_items_table(solved_items, "solved"))
        else:
            block.append(Paragraph("本周暂无解决需求", empty_hint))
        block.append(Spacer(1, 8))
        story.append(KeepTogether(block))

    story.append(Spacer(1, 8))
    story.append(
        Paragraph(
            "说明：提出数 = 本周新建需求；解决数 = 本周首次进入「已实现等待验收 / 已验收完成」的需求。",
            note_style,
        )
    )

    doc.build(story)
    return buffer.getvalue()

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from fastapi import UploadFile

from app.config.settings import BACKEND_ROOT, settings
from app.shared.errors import ValidationError

ALLOWED_ATTACHMENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/jpg",
    "application/pdf",
}
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8MB


def get_upload_root() -> Path:
    raw = Path(settings.upload_dir)
    root = raw if raw.is_absolute() else (BACKEND_ROOT / raw)
    root.mkdir(parents=True, exist_ok=True)
    return root


def public_url_for(relative_posix: str) -> str:
    return "/uploads/{0}".format(relative_posix.lstrip("/"))


async def save_requirement_image(requirement_id: str, upload: UploadFile) -> dict:
    content_type = (upload.content_type or "").lower().strip()
    if content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise ValidationError(
            "仅支持上传图片或 PDF（jpeg/png/gif/webp/pdf）",
            details={"contentType": content_type},
        )

    data = await upload.read()
    if not data:
        raise ValidationError("空文件不可上传")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise ValidationError("附件不能超过 8MB")

    original = (upload.filename or "image").strip() or "image"
    suffix = Path(original).suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"}:
        suffix = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "application/pdf": ".pdf",
        }.get(content_type, ".bin")

    file_id = str(uuid.uuid4())
    rel = "requirements/{0}/{1}{2}".format(requirement_id, file_id, suffix)
    abs_path = get_upload_root() / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(data)

    return {
        "id": file_id,
        "file_name": original[:255],
        "content_type": content_type,
        "size_bytes": len(data),
        "storage_path": str(abs_path),
        "url": public_url_for(rel),
    }

"""开发环境固定测试账号（仅 AUTH_DEV_MODE / 开发登录开启时可用）。"""

from __future__ import annotations

from typing import Dict, List, Optional, TypedDict


class DevPreset(TypedDict):
    key: str
    name: str
    role: str
    label: str
    hint: str


# open_id 规则与 /auth/dev-login 一致：dev:{role}:{name}
DEV_TEST_PRESETS: Dict[str, DevPreset] = {
    "requester": {
        "key": "requester",
        "name": "需求方测试",
        "role": "requester",
        "label": "需求方测试账号",
        "hint": "用于验证提需求、我的需求、验收等需求方功能",
    },
    "executor": {
        "key": "executor",
        "name": "AI效能部",
        "role": "executor",
        "label": "AI效能部测试账号",
        "hint": "用于验证评优先级、推进进度、自提需求与自行验收",
    },
}


def list_dev_presets() -> List[DevPreset]:
    return list(DEV_TEST_PRESETS.values())


def get_dev_preset(key: str) -> Optional[DevPreset]:
    return DEV_TEST_PRESETS.get(key)


def preset_open_id(preset: DevPreset) -> str:
    return "dev:{0}:{1}".format(preset["role"], preset["name"])

import json
import os
import threading
from pathlib import Path
from typing import Any

from .schemas import SceneAction, SceneDetail, SceneUpsertRequest
from .settings import normalize_device_id


class SceneStore:
    def __init__(self, path: Path, built_in: dict[str, list[dict[str, Any]]]) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._built_in = {
            scene_id: SceneDetail(
                id=scene_id,
                name=scene_id.replace("_", " ").title(),
                aliases=[],
                action_count=len(actions),
                source="built_in",
                read_only=True,
                actions=[SceneAction.model_validate(action) for action in actions],
            )
            for scene_id, actions in built_in.items()
        }

    def _load_users(self) -> dict[str, SceneDetail]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        rows = payload.get("scenes") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return {}

        scenes: dict[str, SceneDetail] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                detail = SceneDetail.model_validate({**row, "source": "user", "read_only": False})
            except ValueError:
                continue
            scenes[detail.id] = detail
        return scenes

    def _write_users(self, scenes: dict[str, SceneDetail]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "scenes": [scene.model_dump(mode="json") for scene in sorted(scenes.values(), key=lambda item: item.id)],
        }
        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        os.replace(temp_path, self.path)

    def list(self) -> list[SceneDetail]:
        with self._lock:
            combined = {**self._built_in, **self._load_users()}
            return sorted(combined.values(), key=lambda item: (item.source != "built_in", item.name.lower(), item.id))

    def get(self, scene_id: str) -> SceneDetail | None:
        normalized = normalize_device_id(scene_id)
        with self._lock:
            return self._built_in.get(normalized) or self._load_users().get(normalized)

    def upsert(self, scene_id: str, request: SceneUpsertRequest) -> SceneDetail:
        normalized = normalize_device_id(scene_id)
        if not normalized:
            raise ValueError("Scene ID is invalid.")
        if normalized in self._built_in:
            raise PermissionError("Built-in scenes are read-only.")

        detail = SceneDetail(
            id=normalized,
            name=request.name,
            aliases=[alias.strip() for alias in request.aliases if alias.strip()],
            action_count=len(request.actions),
            source="user",
            read_only=False,
            actions=request.actions,
        )
        with self._lock:
            scenes = self._load_users()
            scenes[normalized] = detail
            self._write_users(scenes)
        return detail

    def delete(self, scene_id: str) -> bool:
        normalized = normalize_device_id(scene_id)
        if normalized in self._built_in:
            raise PermissionError("Built-in scenes are read-only.")
        with self._lock:
            scenes = self._load_users()
            removed = scenes.pop(normalized, None) is not None
            if removed:
                self._write_users(scenes)
            return removed

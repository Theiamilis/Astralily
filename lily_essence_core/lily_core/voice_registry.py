import json
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class VoiceNodeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
    url: str = Field(min_length=8, max_length=512)
    health_url: str = Field(default="", max_length=512)
    token: SecretStr = Field(default_factory=lambda: SecretStr(""))
    profiles: list[str] = Field(default_factory=list, max_length=32)
    priority: int = Field(default=100, ge=0, le=10_000)
    cooldown_seconds: float = Field(default=30.0, ge=1.0, le=3600.0)
    timeout_seconds: float = Field(default=180.0, ge=1.0, le=600.0)

    @field_validator("url", "health_url")
    @classmethod
    def validate_http_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        if not normalized:
            return ""
        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("must be an absolute HTTP(S) URL")
        return normalized

    @field_validator("profiles")
    @classmethod
    def normalize_profiles(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        for value in values:
            profile = value.strip().lower()
            if profile and profile not in normalized:
                normalized.append(profile)
        return normalized

    def resolved_health_url(self) -> str:
        if self.health_url:
            return self.health_url
        for suffix in ("/api/voice/synthesize", "/synthesize"):
            if self.url.endswith(suffix):
                return f"{self.url[:-len(suffix)]}/health"
        return f"{self.url}/health"

    def supports(self, language: str, profile: str) -> bool:
        if not self.profiles:
            return True
        requested = {language.strip().lower(), profile.strip().lower()} - {""}
        return bool(requested.intersection(self.profiles))


def parse_voice_nodes(
    raw_registry: str,
    *,
    legacy_url: str,
    legacy_health_url: str,
    legacy_token: str,
    default_timeout_seconds: float,
) -> list[VoiceNodeConfig]:
    raw = raw_registry.strip()
    if raw:
        decoded: Any = json.loads(raw)
        if not isinstance(decoded, list):
            raise ValueError("LILY_VOICE_SERVICE_REGISTRY must be a JSON array.")
        nodes = [VoiceNodeConfig.model_validate(item) for item in decoded]
    else:
        nodes = []

    if not nodes and legacy_url.strip():
        nodes = [
            VoiceNodeConfig(
                id="default",
                url=legacy_url,
                health_url=legacy_health_url,
                token=SecretStr(legacy_token),
                priority=100,
                timeout_seconds=default_timeout_seconds,
            )
        ]

    identifiers = [node.id for node in nodes]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("Voice node ids must be unique.")
    return [node for _, node in sorted(enumerate(nodes), key=lambda item: (item[1].priority, item[0]))]

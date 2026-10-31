from typing import Literal

from pydantic import BaseModel, Field


class SttSegment(BaseModel):
    start: float
    end: float
    text: str
    avg_logprob: float = 0.0
    no_speech_probability: float = 0.0


class TranscriptionResponse(BaseModel):
    text: str
    language: str = ""
    duration_seconds: float = 0.0
    model: str
    provider: Literal["groq", "local"] = "local"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    no_speech_probability: float = Field(default=0.0, ge=0.0, le=1.0)
    language_probability: float = Field(default=0.0, ge=0.0, le=1.0)
    segments: list[SttSegment] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str
    detail: str

import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .schemas import SttSegment, TranscriptionResponse


class SttProviderError(RuntimeError):
    pass


def _segments_from_payload(payload: dict[str, Any]) -> list[SttSegment]:
    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list):
        return []

    segments: list[SttSegment] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(raw_segment.get("start") or 0.0)
            end = float(raw_segment.get("end") or start)
        except (TypeError, ValueError):
            continue
        segments.append(
            SttSegment(
                start=start,
                end=end,
                text=text,
                avg_logprob=float(raw_segment.get("avg_logprob") or 0.0),
                no_speech_probability=max(
                    0.0,
                    min(1.0, float(raw_segment.get("no_speech_prob") or 0.0)),
                ),
            )
        )
    return segments


def normalize_groq_transcription(
    payload: dict[str, Any],
    model: str,
    language_hint: str = "",
    duration_hint: float | None = None,
) -> TranscriptionResponse:
    segments = _segments_from_payload(payload)
    text = str(payload.get("text") or "").strip()
    if not text and segments:
        text = " ".join(segment.text for segment in segments).strip()

    try:
        duration = float(payload.get("duration") or duration_hint or 0.0)
    except (TypeError, ValueError):
        duration = float(duration_hint or 0.0)

    weights = [max(0.01, segment.end - segment.start) for segment in segments]
    total_weight = sum(weights)
    confidence = (
        sum(pow(2.718281828, segment.avg_logprob) * weight for segment, weight in zip(segments, weights))
        / total_weight
        if total_weight
        else (0.75 if text else 0.0)
    )
    no_speech_probability = (
        sum(segment.no_speech_probability * weight for segment, weight in zip(segments, weights)) / total_weight
        if total_weight
        else 0.0
    )

    return TranscriptionResponse(
        text=text,
        language=str(payload.get("language") or language_hint or "").strip().lower(),
        duration_seconds=duration,
        model=model,
        provider="groq",
        confidence=max(0.0, min(1.0, confidence)),
        no_speech_probability=max(0.0, min(1.0, no_speech_probability)),
        language_probability=max(
            0.0,
            min(1.0, float(payload.get("language_probability") or 0.0)),
        ),
        segments=segments,
    )


@dataclass(frozen=True)
class GroqSttClient:
    api_key: str
    base_url: str
    model: str
    timeout_seconds: float

    @property
    def configured(self) -> bool:
        return bool(self.api_key.strip())

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        language: str = "",
        duration_hint: float | None = None,
    ) -> TranscriptionResponse:
        if not self.configured:
            raise SttProviderError("Groq is not configured.")

        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        data = {
            "model": self.model,
            "response_format": "verbose_json",
            "temperature": "0",
        }
        selected_language = language.strip().lower()
        if selected_language:
            data["language"] = selected_language

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url.rstrip('/')}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    data=data,
                    files={"file": (filename, audio, content_type)},
                )
                response.raise_for_status()
        except httpx.TimeoutException as error:
            raise SttProviderError("Groq transcription timed out.") from error
        except httpx.HTTPStatusError as error:
            raise SttProviderError(f"Groq returned HTTP {error.response.status_code}.") from error
        except httpx.RequestError as error:
            raise SttProviderError("Groq transcription could not be reached.") from error

        try:
            payload = response.json()
        except ValueError as error:
            raise SttProviderError("Groq returned an invalid response.") from error
        if not isinstance(payload, dict):
            raise SttProviderError("Groq returned an invalid response.")

        result = normalize_groq_transcription(
            payload,
            model=self.model,
            language_hint=selected_language,
            duration_hint=duration_hint,
        )
        if not result.text:
            raise SttProviderError("Groq returned an empty transcription.")
        return result


def upload_filename(path: Path) -> str:
    suffix = path.suffix.lower() or ".audio"
    return f"lily_voice_note{suffix}"

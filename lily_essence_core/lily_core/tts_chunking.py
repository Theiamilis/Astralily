"""Natural text chunk planning for multi-request TTS backends.

The planner deliberately prefers fewer, longer chunks.  GPT-SoVITS and voice
cloning services can lose prosody when a sentence is split too aggressively,
so punctuation is used as the primary boundary and hard splitting is only a
last resort for unusually long text without punctuation.
"""

from __future__ import annotations

import re


_HARD_PUNCTUATION = ".!?。！？…"
_SOFT_PUNCTUATION = ",，、;；:："
_DRAMATIC_MARKERS = {
    "angry",
    "怒り",
    "dramatic",
    "excited",
    "furious",
    "happy",
    "joy",
    "sad",
    "悲しい",
    "shout",
    "theatrical",
    "upset",
}


def _normalized(value: object | None) -> str:
    return " ".join(str(value or "").split()).strip()


def _contains_cjk_or_kana(value: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]", value))


def _word_count(value: str) -> int:
    if _contains_cjk_or_kana(value):
        return len(re.findall(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+", value))
    return len(re.findall(r"\S+", value))


def _split_sentences(value: str) -> list[str]:
    """Split after hard punctuation, including punctuation without spaces."""
    parts = re.split(
        rf"(?<=[{re.escape(_HARD_PUNCTUATION)}])(?:\s+|(?=\S))",
        value,
    )
    return [part.strip() for part in parts if part and part.strip()]


def _split_soft_clauses(value: str) -> list[str]:
    parts = re.split(
        rf"(?<=[{re.escape(_SOFT_PUNCTUATION)}])(?:\s+|(?=\S))",
        value,
    )
    return [part.strip() for part in parts if part and part.strip()]


def _hard_split(value: str, max_chars: int) -> list[str]:
    """Last-resort split that avoids cutting an English word in half."""
    if len(value) <= max_chars:
        return [value]

    result: list[str] = []
    remaining = value.strip()
    while len(remaining) > max_chars:
        window = remaining[:max_chars]
        boundary = max(window.rfind(" "), window.rfind("\n"))
        if boundary < max_chars // 2:
            boundary = max_chars
        result.append(remaining[:boundary].strip())
        remaining = remaining[boundary:].strip()
    if remaining:
        result.append(remaining)
    return [part for part in result if part]


def _merge_parts(parts: list[str], max_chars: int, max_words: int) -> list[str]:
    merged: list[str] = []
    current = ""
    for part in parts:
        candidate = f"{current} {part}".strip() if current else part
        if current and (len(candidate) > max_chars or _word_count(candidate) > max_words):
            merged.append(current)
            current = part
        else:
            current = candidate
    if current:
        merged.append(current)
    return merged


def _requires_full_synthesis(text: str, emotion: str, style: str, max_chars: int, max_words: int) -> bool:
    if len(text) <= max_chars and _word_count(text) <= max_words:
        return True
    labels = f"{emotion} {style}".lower()
    return any(marker in labels for marker in _DRAMATIC_MARKERS)


def plan_tts_chunks(
    text: str | None,
    *,
    emotion: str = "",
    style: str = "",
    max_chars: int = 220,
    max_words: int = 30,
) -> list[str]:
    """Return natural TTS chunks while preserving the original text order.

    Short replies and marked emotional/dramatic replies intentionally return
    one chunk so the voice engine can keep a single prosodic arc.
    """
    normalized = _normalized(text)
    if not normalized:
        return []

    safe_max_chars = max(80, int(max_chars))
    safe_max_words = max(12, int(max_words))
    if _requires_full_synthesis(normalized, emotion, style, safe_max_chars, safe_max_words):
        return [normalized]

    sentence_parts = _split_sentences(normalized)
    clause_parts: list[str] = []
    for sentence in sentence_parts or [normalized]:
        soft_parts = _split_soft_clauses(sentence)
        for clause in soft_parts or [sentence]:
            clause_parts.extend(_hard_split(clause, safe_max_chars))

    chunks = _merge_parts(clause_parts, safe_max_chars, safe_max_words)
    return chunks or [normalized]


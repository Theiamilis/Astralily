import re


_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:https?://|www\.)[^)\s]+\)", re.IGNORECASE)
_RAW_URL_RE = re.compile(r"\b(?:https?://|www\.)\S+", re.IGNORECASE)
_CONTROL_BRACKET_RE = re.compile(
    r"\[\s*(?:expression|expr|face|emotion|mood)\s*:[^\]]*\]",
    re.IGNORECASE,
)
_CONTROL_ANGLE_RE = re.compile(
    r"<\s*(?:expression|expr|face|emotion|mood)\s*:[^>]*>",
    re.IGNORECASE,
)
_CONTROL_BRACE_RE = re.compile(
    r"\{\s*(?:\"?(?:expression|expr|face|emotion|mood)\"?)\s*:[^}]*\}",
    re.IGNORECASE,
)
_SIMPLE_FACE_TAG_RE = re.compile(
    r"<\s*(?:happy|joy|cheer|cheerful|love|soft love|blush|shy|neutral|calm|sad|gloomy|cry|crying|teary|sweat|nervous|angry|annoyed|warning|serious|sparkle(?: mood)?)\s*>",
    re.IGNORECASE,
)
_EMOJI_RE = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA70-\U0001FAFF"
    "\U00002700-\U000027BF"
    "\U00002600-\U000026FF"
    "]+"
)
_DECORATIVE_SYMBOL_RE = re.compile(r"[♡♥❤💕💖💗💘💝✨✦✧★☆◆◇●○■□▲△▼▽]+")
_EMOTICON_RE = re.compile(
    r"(?:(?<=\s)|^)(?:[:;=8xX][-']?[)(DPpOo/\\]|T[_-]?T|QQ|orz|\^\^+)(?=\s|$|[.!?,])",
    re.IGNORECASE,
)
_JSON_ONLY_LINE_RE = re.compile(r"^\s*(?:\{.*\}|\[.*\])\s*,?\s*$")
_METADATA_ONLY_LINE_RE = re.compile(
    r"^\s*(?:id|task id|request id|trace id|provider|model|metadata|payload|raw|debug|status|action|source|signals|tool|tool id)\s*[:=].*$",
    re.IGNORECASE,
)
_INLINE_ID_RE = re.compile(r"\b(?:ID|Tool ID|Task ID|Request ID|Trace ID)\s*:\s*(?:tool_)?[A-Za-z0-9_-]+\b", re.IGNORECASE)
_WORD_STRETCH_RE = re.compile(r"([A-Za-z])\1{2,}")
_INNER_CLAUSE_BREAK_RE = re.compile(r"(?<=\w)\s*[:;]+\s*(?=\w)")
_INNER_SENTENCE_BREAK_RE = re.compile(r"(?<=\w)\s*(?:\.{2,}|[!?~]+|[.!?~]{2,})\s+([A-Za-z])")
_GREETING_BREAK_RE = re.compile(r"\b(halo|hello|hai|hi|hey)\s*(?:[,.!?~:;]+)?\s+([A-Za-z][A-Za-z'’-]*)", re.IGNORECASE)

_SOFT_GREETING_WORDS = {
    "aku",
    "gue",
    "gw",
    "saya",
    "kami",
    "kita",
    "i",
    "im",
    "i'm",
    "me",
    "you",
    "kamu",
    "lagi",
    "mau",
    "siap",
    "cek",
    "tunggu",
}


def _drop_machine_lines(text: str) -> str:
    lines: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            lines.append("")
            continue

        if _JSON_ONLY_LINE_RE.match(line) or _METADATA_ONLY_LINE_RE.match(line):
            continue

        line = _INLINE_ID_RE.sub("", line).strip()
        if line:
            lines.append(line)

    return "\n".join(lines)


def _normalize_greeting_pause(match: re.Match[str]) -> str:
    greeting = match.group(1)
    next_word = match.group(2)
    if next_word.lower() in _SOFT_GREETING_WORDS:
        next_word = next_word.lower()
    return f"{greeting}, {next_word}"


def _normalize_inner_sentence_break(match: re.Match[str]) -> str:
    next_char = match.group(1)
    pause = "," if next_char.islower() else "."
    return f"{pause} {next_char}"


def _normalize_sentence_spacing(text: str) -> str:
    text = _INNER_CLAUSE_BREAK_RE.sub(", ", text)
    text = _INNER_SENTENCE_BREAK_RE.sub(_normalize_inner_sentence_break, text)
    text = re.sub(r"[!?~]+", ".", text)
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"[:;]+", ".", text)
    text = re.sub(r",{2,}", ",", text)
    text = re.sub(r"\.\s*,", ".", text)
    text = re.sub(r",\s*\.", ".", text)
    text = re.sub(r"\s+([,.])", r"\1", text)
    text = re.sub(r"([,.])(?=\S)", r"\1 ", text)
    text = _GREETING_BREAK_RE.sub(_normalize_greeting_pause, text)
    text = re.sub(r"\s+", " ", text).strip(" \t\r\n,._-*~|")
    text = re.sub(r"\s+([.])$", r"\1", text)
    text = re.sub(r"([,])\s*$", ".", text)
    text = re.sub(r"([,.]){2,}", lambda match: "." if "." in match.group(0) else ",", text)

    if not any(character.isalnum() for character in text):
        return ""

    if text and text[-1] not in ".,。！？":  # pragma: no cover - defensive normalization
        terminal = "。" if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text) else "."
        text = f"{text}{terminal}"
    elif text and text[-1] == ",":
        text = f"{text}."

    return text


def sanitize_for_tts(text: str | None) -> str:
    """Return a speech-safe version of Lily's final display reply."""
    if not text:
        return ""

    cleaned = str(text).replace("\r\n", "\n").replace("\r", "\n")
    cleaned = _CODE_BLOCK_RE.sub(" ", cleaned)
    cleaned = _MARKDOWN_LINK_RE.sub(r"\1", cleaned)
    cleaned = _RAW_URL_RE.sub(" ", cleaned)
    cleaned = _CONTROL_BRACKET_RE.sub(" ", cleaned)
    cleaned = _CONTROL_ANGLE_RE.sub(" ", cleaned)
    cleaned = _CONTROL_BRACE_RE.sub(" ", cleaned)
    cleaned = _SIMPLE_FACE_TAG_RE.sub(" ", cleaned)
    cleaned = _drop_machine_lines(cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = cleaned.replace("`", "")
    cleaned = re.sub(r"[*_]{1,3}([^*_]+)[*_]{1,3}", r"\1", cleaned)
    cleaned = re.sub(r"^[#>\-\s]*", "", cleaned)
    cleaned = _EMOJI_RE.sub(" ", cleaned)
    cleaned = _DECORATIVE_SYMBOL_RE.sub(" ", cleaned)
    cleaned = cleaned.replace("\ufe0f", "").replace("\u200d", "")
    cleaned = _EMOTICON_RE.sub(" ", cleaned)
    cleaned = re.sub(r"\b(?:w+k+){2,}\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b(?:ha){3,}\b", "haha", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[~=\-]{2,}", " ", cleaned)
    cleaned = _WORD_STRETCH_RE.sub(r"\1", cleaned)

    return _normalize_sentence_spacing(cleaned)

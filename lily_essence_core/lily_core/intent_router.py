import asyncio
import json
import re
from typing import Any

from .home_control import parse_home_command
from .providers import run_text_task
from .schemas import IntentRouteRequest, IntentRouteResult
from .settings import settings


ALLOWED_DOMAINS = {
    "chat",
    "finance",
    "file",
    "home",
    "power",
    "presence",
    "tool",
    "voice",
    "task",
    "unknown",
}

ALLOWED_INTENTS = {
    "chat",
    "finance_interpret",
    "finance_summary",
    "finance_recent_transactions",
    "finance_month_expense",
    "finance_period_followup",
    "file_search",
    "file_confirm",
    "file_cancel",
    "file_repeat_search",
    "home_control",
    "home_status",
    "wake_pc",
    "presence_set",
    "tool_approve",
    "tool_deny",
    "voice_request",
    "task_request",
    "unknown",
}

FINANCE_ACCOUNT_ALIASES = {
    "bca": ("bca",),
    "mandiri": ("mandiri",),
    "gopay": ("gopay", "go pay"),
    "dana": ("dana",),
    "cash": ("cash", "tunai"),
}

FINANCE_WORD_RE = re.compile(
    r"\b(?:saldo|balance|uang|duit|rekening|akun|finance|keuangan|bca|mandiri|gopay|go\s*pay|"
    r"dana|cash|tunai|tf|transfer|kirim(?:in)?|bayar|beli|jajan|isi|top\s*up|gaji|income|"
    r"expense|pengeluaran|pemasukan|tagihan|struk|admin|biaya|fee|langganan|subscription)\b",
    re.I,
)
FINANCE_ACTION_RE = re.compile(r"\b(?:berapa|cek|check|lihat|liat|show|summary|ringkasan|total|sisa)\b", re.I)
FINANCE_AMOUNT_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:k|rb|ribu|jt|juta)?\b", re.I)
FINANCE_TRANSACTION_RE = re.compile(
    r"\b(?:tf|transfer|kirim(?:in)?|bayar|beli|jajan|isi|top\s*up|gaji|income|expense|"
    r"pengeluaran|pemasukan|admin|biaya|fee|tagihan|langganan|subscription)\b",
    re.I,
)
FILE_OBJECT_RE = re.compile(r"\b(?:file|gambar|image|foto|photo|wallpaper|download|downloads|desktop|folder)\b", re.I)
FILE_ACTION_RE = re.compile(r"\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin|cari|cek|check|search|lihat|liat|refresh)\b", re.I)
FILE_DANGEROUS_RE = re.compile(r"\b(?:hapus|delete|move|pindah(?:in)?|mindahin|edit|ubah|rename)\b", re.I)
FILE_REPEAT_OBJECT_RE = re.compile(
    r"\b(?:file|filenya|folder|pencarian(?:\s+file)?|hasil(?:\s+pencarian)?)\b",
    re.I,
)
FILE_REPEAT_ACTION_RE = re.compile(
    r"\b(?:cek|check|cari|search|lihat|liat|ulang|refresh)\b",
    re.I,
)
WAKE_RE = re.compile(r"\b(?:wake|turn\s+on|nyala(?:in|kan)?|hidup(?:in|kan)?|bangunin)\b", re.I)
PC_RE = re.compile(r"\b(?:pc|core|computer|komputer|windows)\b", re.I)
PRESENCE_RE = re.compile(
    r"\b(?:status|available|normal|online|aktif|sibuk|busy|meeting|kantor|kerja|office|"
    r"tidur|sleep|sleeping|istirahat|main\s+game|gaming|ranked|away|pergi|keluar)\b",
    re.I,
)
TOOL_ID_RE = re.compile(r"\btool_[a-z0-9]+\b", re.I)
APPROVE_RE = re.compile(r"\b(?:approve|setujui|setujuin|izinkan|izin|acc|okein|lanjutkan|jalanin|gasin|gas)\b", re.I)
DENY_RE = re.compile(r"\b(?:deny|tolak|batal|batalin|cancel|stop|skip|jangan\s+jadi)\b", re.I)


def _chat(confidence: float = 1.0, reason: str = "normal_chat") -> IntentRouteResult:
    return IntentRouteResult(domain="chat", intent="chat", confidence=confidence, reason=reason)


def _clamp_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, confidence))


def _lower_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).lower()


def _strip_lily_prefix(text: str) -> str:
    return re.sub(r"^\s*(?:lily|lili|ly)\b[\s,.:;-]*", "", text or "", flags=re.I).strip()


def _extract_account(text: str) -> str:
    lower = _lower_text(text)
    for account, aliases in FINANCE_ACCOUNT_ALIASES.items():
        for alias in aliases:
            if re.search(rf"\b{re.escape(alias)}\b", lower):
                return account
    match = re.search(r"\bsaldo\s+([a-z0-9 _-]{2,40}?)(?:\s+(?:ada|berapa|sisa|dong|ya|kah|nih|ini)|$)", lower, re.I)
    return re.sub(r"[^a-z0-9]+", "_", match.group(1)).strip("_") if match else ""


def _extract_task_id(text: str) -> str:
    match = TOOL_ID_RE.search(text or "")
    return match.group(0) if match else ""


def _extract_index(text: str) -> int | None:
    match = re.match(r"^\s*(?:nomor|no\.?)?\s*([1-9]\d?)\s*\.?\s*$", text or "", re.I)
    if match:
        return int(match.group(1))
    words = {
        "satu": 1,
        "pertama": 1,
        "dua": 2,
        "kedua": 2,
        "tiga": 3,
        "ketiga": 3,
        "empat": 4,
        "keempat": 4,
        "lima": 5,
        "kelima": 5,
    }
    lower = _lower_text(text)
    for word, index in words.items():
        if re.fullmatch(rf"(?:yang\s+)?{word}", lower):
            return index
    return None


def _presence_status(text: str) -> str:
    lower = _lower_text(text)
    if re.search(r"\b(?:available|normal|online|aktif|ada)\b", lower):
        return "available"
    if re.search(r"\b(?:kantor|kerja|office|at office)\b", lower):
        return "at_office"
    if re.search(r"\b(?:tidur|sleep|sleeping|istirahat)\b", lower):
        return "sleeping"
    if re.search(r"\b(?:main\s+game|gaming|ranked|game)\b", lower):
        return "gaming"
    if re.search(r"\b(?:away|pergi|keluar)\b", lower):
        return "away"
    if re.search(r"\b(?:sibuk|busy|meeting)\b", lower):
        return "busy"
    return ""


def _clean_file_query(text: str) -> str:
    query = _strip_lily_prefix(text)
    query = re.sub(r"\b(?:tolong|please|dong|dah|ya|juga|lagi)\b", " ", query, flags=re.I)
    query = re.sub(r"\b(?:kirim(?:in)?|send|ambil(?:in)?|copy|salin|cari|cek|check|search|lihat|liat|refresh)\b", " ", query, flags=re.I)
    query = re.sub(r"\b(?:file|gambar|image|foto|photo|folder|download|downloads|desktop|pictures|galeri)\b", " ", query, flags=re.I)
    query = re.sub(
        r"\b(?:dari|di|ke|from|in|on|pc|laptop|windows|lily-core-host|Lily-Voice-Host|iris[- ]?forest|"
        r"Lily-Voice-Host|Lily-Storage-Host|Lily-Storage-Host|Lily-Core-Host|Lily-Core-Host|Owner-Mobile|Owner-Mobile|Owner-Mobile)\b",
        " ",
        query,
        flags=re.I,
    )
    return re.sub(r"\s+", " ", query).strip(" ._-")


def _file_root(text: str) -> str:
    lower = _lower_text(text)
    if re.search(r"\b(?:desktop|dekstop)\b", lower):
        return "desktop"
    if re.search(r"\b(?:pictures|picture|photo|photos|gallery|galeri)\b", lower):
        return "pictures"
    return "downloads"


def _file_device(text: str, context: dict[str, Any]) -> str:
    lower = _lower_text(text)
    vessels = context.get("available_vessels") or []
    if not isinstance(vessels, list):
        return ""
    for vessel in vessels:
        if not isinstance(vessel, dict):
            continue
        key = str(vessel.get("key") or "").strip()
        label = str(vessel.get("label") or "").strip().lower()
        aliases = vessel.get("aliases") or []
        names = [key.lower(), label, *[str(alias).lower() for alias in aliases]]
        if key and any(name and re.search(rf"\b{re.escape(name)}\b", lower) for name in names):
            return key
    return ""


def _is_explicit_file_repeat(text: str) -> bool:
    lower = _lower_text(text)
    if FILE_REPEAT_OBJECT_RE.search(lower) and FILE_REPEAT_ACTION_RE.search(lower):
        return True
    return bool(
        re.fullmatch(
            r"(?:cek|check|cari|search|ulang|refresh|coba)(?:\s+(?:lagi|ulang))?",
            lower,
            re.I,
        )
    )


def _heuristic_route(request: IntentRouteRequest) -> IntentRouteResult:
    text = (request.message or "").strip()
    without_lily = _strip_lily_prefix(text)
    lower = _lower_text(without_lily)
    context = request.context or {}
    pending_file_count = int(context.get("pending_file_count") or 0)
    recent_file_query = str(context.get("recent_file_query") or "").strip()

    if not lower:
        return _chat(reason="empty_message")

    if pending_file_count > 0 and DENY_RE.search(lower):
        return IntentRouteResult(domain="file", intent="file_cancel", confidence=0.96, reason="pending_file_cancel")
    if pending_file_count > 0:
        index = _extract_index(lower)
        if index is not None or re.fullmatch(r"(?:gas|kirim|send|iya|ya|ok|oke|lanjut)", lower):
            return IntentRouteResult(
                domain="file",
                intent="file_confirm",
                confidence=0.95,
                reason="pending_file_confirm",
                params={"index": index},
            )

    if recent_file_query and _is_explicit_file_repeat(lower):
        return IntentRouteResult(domain="file", intent="file_repeat_search", confidence=0.88, reason="recent_file_followup")

    task_id = _extract_task_id(lower)
    if task_id and APPROVE_RE.search(lower):
        return IntentRouteResult(domain="tool", intent="tool_approve", confidence=0.96, reason="tool_approve", params={"taskId": task_id})
    if task_id and DENY_RE.search(lower):
        return IntentRouteResult(domain="tool", intent="tool_deny", confidence=0.96, reason="tool_deny", params={"taskId": task_id})

    if WAKE_RE.search(lower) and PC_RE.search(lower):
        return IntentRouteResult(domain="power", intent="wake_pc", confidence=0.95, reason="wake_pc")

    home_command = parse_home_command(without_lily)
    if home_command and home_command.explicit_home_hint:
        return IntentRouteResult(
            domain="home",
            intent="home_status" if home_command.operation == "status" else "home_control",
            confidence=0.96,
            reason="home_command",
            params=home_command.model_dump(exclude={"explicit_home_hint"}, exclude_none=True),
        )

    if FILE_OBJECT_RE.search(lower) and FILE_ACTION_RE.search(lower):
        if FILE_DANGEROUS_RE.search(lower):
            return IntentRouteResult(domain="task", intent="task_request", confidence=0.82, reason="file_mutation_needs_tool")
        return IntentRouteResult(
            domain="file",
            intent="file_search",
            confidence=0.88,
            reason="file_search",
            params={
                "query": _clean_file_query(without_lily),
                "root": _file_root(lower),
                "desiredKind": "image" if re.search(r"\b(?:gambar|image|foto|photo|wallpaper)\b", lower) else "file",
                "device": _file_device(lower, context),
                "searchAllVessels": bool(re.search(r"\b(?:semua|all)\b.*\b(?:device|storage|pc|laptop)\b", lower)),
            },
        )

    if FINANCE_WORD_RE.search(lower):
        if FINANCE_ACTION_RE.search(lower) and not FINANCE_AMOUNT_RE.search(lower):
            return IntentRouteResult(
                domain="finance",
                intent="finance_summary",
                confidence=0.90,
                reason="finance_summary",
                params={"account": _extract_account(lower)},
            )
        if FINANCE_AMOUNT_RE.search(lower) or FINANCE_TRANSACTION_RE.search(lower):
            return IntentRouteResult(
                domain="finance",
                intent="finance_interpret",
                confidence=0.90 if FINANCE_AMOUNT_RE.search(lower) else 0.78,
                reason="finance_transaction",
                params={"strict": bool(FINANCE_AMOUNT_RE.search(lower))},
            )

    if PRESENCE_RE.search(lower) and re.search(r"\b(?:status|available|normal|online|aktif|sibuk|busy|meeting|kantor|kerja|office|tidur|sleep|sleeping|istirahat|gaming|ranked|away|pergi|keluar)\b", lower):
        status = _presence_status(lower)
        if status:
            return IntentRouteResult(domain="presence", intent="presence_set", confidence=0.84, reason="presence_set", params={"status": status})

    if re.search(r"\b(?:voice|suara|tts|sovits|ngomong|jawab\s+pake\s+suara)\b", lower):
        return IntentRouteResult(domain="voice", intent="voice_request", confidence=0.78, reason="voice_request")

    return _chat()


def _router_hint_present(request: IntentRouteRequest) -> bool:
    text = _lower_text(_strip_lily_prefix(request.message))
    if len(text) > 800:
        return False
    if request.context.get("pending_file_count") or request.context.get("recent_file_query"):
        return True
    hint_patterns = (
        FINANCE_WORD_RE,
        FILE_OBJECT_RE,
        WAKE_RE,
        re.compile(r"\b(?:lampu|light|lights|wiz|teras|kamar|clairie\s+lab)\b", re.I),
        PRESENCE_RE,
        TOOL_ID_RE,
        re.compile(r"\b(?:voice|suara|tts|sovits|tool|task|openclaw)\b", re.I),
    )
    return any(pattern.search(text) for pattern in hint_patterns)


def _router_prompt(request: IntentRouteRequest) -> str:
    context = request.context or {}
    safe_context = {
        "pending_file_count": context.get("pending_file_count") or 0,
        "pending_candidates": context.get("pending_candidates") or [],
        "recent_file_query": context.get("recent_file_query") or "",
        "available_vessels": context.get("available_vessels") or [],
        "has_pending_finance_draft": bool(context.get("has_pending_finance_draft")),
        "has_finance_summary_context": bool(context.get("has_finance_summary_context")),
    }
    return (
        "Classify this owner message for Lily. Return exactly one compact JSON object and no markdown.\n"
        "Schema: {\"domain\":\"chat\",\"intent\":\"chat\",\"confidence\":0.0,\"reason\":\"\",\"params\":{}}\n"
        "Domains: chat, finance, file, home, power, presence, tool, voice, task, unknown.\n"
        "Intents: chat, finance_interpret, finance_summary, finance_recent_transactions, finance_month_expense, "
        "finance_period_followup, file_search, file_confirm, file_cancel, file_repeat_search, home_control, "
        "home_status, wake_pc, "
        "presence_set, tool_approve, tool_deny, voice_request, task_request, unknown.\n"
        "Finance means balance questions, spending/income notes, transfers to other people, bills, subscriptions, "
        "receipts, admin fees, or account questions. Use finance_interpret for money movement with an amount. "
        "Use finance_summary for balance/summary questions and put account in params.account when named.\n"
        "File means finding/sending existing files only. Moving, deleting, editing, or renaming files is task_request.\n"
        "A casual story about seeing a person, photo, store, or something earlier is chat. Words such as tadi, lihat, "
        "liat, or lagi alone never mean file_repeat_search; that intent requires an explicit request to repeat a recent "
        "file search.\n"
        "When recent_file_query is non-empty and the owner explicitly says cek file tadi, ulang pencarian, or cek lagi, "
        "use file_repeat_search rather than file_search so the bridge can preserve the previous search scope.\n"
        "Home means controlling or checking configured smart-home devices such as lights. Use home_control for "
        "on/off/brightness/color commands and home_status for state questions.\n"
        "For file_search params: query, root downloads|desktop|pictures, desiredKind file|image, device, searchAllVessels.\n"
        "For file_confirm params.index is 1-based. For presence_set params.status is available|busy|at_office|sleeping|gaming|away.\n"
        "For tool decisions params.taskId must contain tool_xxx. If unsure, return chat with low confidence.\n"
        f"Context: {json.dumps(safe_context, ensure_ascii=True)}\n"
        f"Message: {json.dumps(request.message or '', ensure_ascii=True)}"
    )


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _intent_domain(intent: str) -> str:
    if intent.startswith("finance_"):
        return "finance"
    if intent.startswith("file_"):
        return "file"
    if intent.startswith("home_"):
        return "home"
    if intent == "wake_pc":
        return "power"
    if intent.startswith("tool_"):
        return "tool"
    if intent == "presence_set":
        return "presence"
    if intent == "voice_request":
        return "voice"
    if intent == "task_request":
        return "task"
    if intent == "unknown":
        return "unknown"
    return "chat"


def _normalize_llm_route(payload: dict[str, Any] | None) -> IntentRouteResult | None:
    if not payload:
        return None
    raw_intent = str(payload.get("intent") or "").strip().lower()
    intent = raw_intent if raw_intent in ALLOWED_INTENTS else "chat"
    raw_domain = str(payload.get("domain") or "").strip().lower()
    domain = raw_domain if raw_domain in ALLOWED_DOMAINS else _intent_domain(intent)
    confidence = _clamp_confidence(payload.get("confidence"))
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}

    if intent != "chat" and confidence < settings.intent_router_min_confidence:
        intent = "chat"
        domain = "chat"

    return IntentRouteResult(
        source="core_router_llm",
        domain=domain,
        intent=intent,
        confidence=confidence,
        reason=str(payload.get("reason") or "").strip()[:160],
        params=params,
    )


async def route_owner_intent(request: IntentRouteRequest) -> IntentRouteResult:
    heuristic = _heuristic_route(request)
    deterministic_intents = {"file_confirm", "file_cancel", "tool_approve", "tool_deny"}
    if heuristic.intent in deterministic_intents and heuristic.confidence >= settings.intent_router_min_confidence:
        heuristic.source = "core_router_rules"
        return heuristic

    if not settings.intent_router_enabled or not _router_hint_present(request):
        heuristic.source = "core_router_rules"
        return heuristic

    session = {"session_id": request.session_id, "mode": "owner_router"}
    try:
        raw = await asyncio.wait_for(
            run_text_task(
                _router_prompt(request),
                "You are a strict intent router. Return JSON only.",
                session,
                max_tokens=240,
                temperature=0.0,
            ),
            timeout=max(0.5, settings.intent_router_timeout_seconds),
        )
        routed = _normalize_llm_route(_extract_json_object(raw))
        return routed or heuristic
    except Exception as error:
        return IntentRouteResult(
            source="core_router_fallback",
            domain=heuristic.domain,
            intent=heuristic.intent,
            confidence=heuristic.confidence,
            reason=f"router_fallback:{str(error)[:120]}",
            params=heuristic.params,
        )

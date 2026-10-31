import base64
import time
import uuid
from threading import Lock
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .settings import settings
from .state_store import CoreStateStore, core_state_store


class FinanceProxyError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 503) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class StrictFinanceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class FinanceTransactionInput(StrictFinanceModel):
    direction: Literal["income", "expense", "transfer"]
    amount: int = Field(gt=0, le=10**15)
    account: str = Field(min_length=1, max_length=40)
    to_account: str | None = Field(default=None, max_length=40)
    category_id: str | None = Field(default=None, max_length=100)
    category: str = Field(default="uncategorized", min_length=1, max_length=80)
    merchant: str | None = Field(default=None, max_length=120)
    note: str = Field(default="", max_length=500)
    occurred_at: str | None = Field(default=None, max_length=64)
    currency: str | None = Field(default=None, max_length=8)
    attachment_ids: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_transfer_target(self) -> "FinanceTransactionInput":
        if self.direction == "transfer" and not self.to_account:
            raise ValueError("to_account is required for transfers")
        if self.direction != "transfer" and self.to_account:
            raise ValueError("to_account is only valid for transfers")
        if self.to_account and self.to_account.lower() == self.account.lower():
            raise ValueError("transfer accounts must be different")
        return self


class FinanceDraftCreate(StrictFinanceModel):
    transaction: FinanceTransactionInput


class FinanceInterpretRequest(StrictFinanceModel):
    message: str = Field(min_length=1, max_length=500)
    reply_language: Literal["id", "en"] = "id"
    recent_intent: Literal["chat", "balance_query", "period_followup", "clarification", "transaction_draft"] | None = None
    recent_account: str | None = Field(default=None, max_length=80)
    recent_period: str | None = Field(default=None, max_length=40)


class FinanceConfirmRequest(StrictFinanceModel):
    confirmed: Literal[True] = True


class FinanceDraft(BaseModel):
    id: str
    transaction: FinanceTransactionInput
    source: Literal["mobile", "private", "api", "receipt"]
    created_at: float
    expires_at: float
    status: Literal["pending", "confirming"] = "pending"


class FinanceDraftStore:
    def __init__(self, ttl_seconds: int, state_store: CoreStateStore | None = None) -> None:
        self.ttl_seconds = max(60, ttl_seconds)
        self.state_store = state_store
        self._lock = Lock()
        self._drafts: dict[str, FinanceDraft] = {}
        if state_store:
            for draft_id, payload in state_store.load_finance_drafts().items():
                try:
                    self._drafts[draft_id] = FinanceDraft.model_validate(payload)
                except ValueError:
                    state_store.delete_finance_draft(draft_id)

    def _purge_locked(self) -> None:
        now = time.time()
        expired = [draft_id for draft_id, draft in self._drafts.items() if draft.expires_at <= now]
        for draft_id in expired:
            self._drafts.pop(draft_id, None)
            if self.state_store:
                self.state_store.delete_finance_draft(draft_id)

    def create(self, transaction: FinanceTransactionInput, source: str) -> FinanceDraft:
        now = time.time()
        draft = FinanceDraft(
            id=f"fd_{uuid.uuid4().hex}",
            transaction=transaction,
            source=source,
            created_at=now,
            expires_at=now + self.ttl_seconds,
        )
        with self._lock:
            self._purge_locked()
            self._drafts[draft.id] = draft
            if self.state_store:
                self.state_store.save_finance_draft(draft.id, draft.model_dump(), draft.expires_at)
        return draft.model_copy(deep=True)

    def get(self, draft_id: str) -> FinanceDraft | None:
        with self._lock:
            self._purge_locked()
            draft = self._drafts.get(draft_id)
            return draft.model_copy(deep=True) if draft else None

    def begin_confirmation(self, draft_id: str) -> FinanceDraft | None:
        with self._lock:
            self._purge_locked()
            draft = self._drafts.get(draft_id)
            if not draft or draft.status != "pending":
                return None
            draft.status = "confirming"
            if self.state_store:
                self.state_store.save_finance_draft(draft.id, draft.model_dump(), draft.expires_at)
            return draft.model_copy(deep=True)

    def restore(self, draft_id: str) -> None:
        with self._lock:
            draft = self._drafts.get(draft_id)
            if draft:
                draft.status = "pending"
                if self.state_store:
                    self.state_store.save_finance_draft(draft.id, draft.model_dump(), draft.expires_at)

    def delete(self, draft_id: str) -> bool:
        with self._lock:
            removed = self._drafts.pop(draft_id, None) is not None
            if removed and self.state_store:
                self.state_store.delete_finance_draft(draft_id)
            return removed


class FinanceVesselClient:
    def __init__(self, base_url: str, token: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_seconds = timeout_seconds

    def _headers(self) -> dict[str, str]:
        return {"X-Lily-Finance-Token": self.token} if self.token else {}

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.base_url:
            raise FinanceProxyError("Finance service is not configured.")
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.request(
                    method,
                    f"{self.base_url}{path}",
                    headers=self._headers(),
                    params=params,
                    json=json,
                )
        except httpx.TimeoutException as error:
            raise FinanceProxyError("Finance service timed out.", 504) from error
        except httpx.RequestError as error:
            raise FinanceProxyError("Finance service is unavailable.", 503) from error

        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            detail = payload.get("detail") if isinstance(payload, dict) else None
            safe_detail = str(detail or "Finance request failed.")[:500]
            status_code = response.status_code if response.status_code in {400, 404, 409, 422} else 502
            raise FinanceProxyError(safe_detail, status_code)
        if not isinstance(payload, dict):
            raise FinanceProxyError("Finance service returned an invalid response.", 502)
        return payload


finance_drafts = FinanceDraftStore(settings.finance_draft_ttl_seconds, core_state_store)


def create_finance_client() -> FinanceVesselClient:
    return FinanceVesselClient(
        settings.finance_vessel_url,
        settings.finance_vessel_token,
        settings.finance_vessel_timeout_seconds,
    )


def transaction_from_upstream(payload: Any) -> FinanceTransactionInput | None:
    if not isinstance(payload, dict):
        return None
    safe_payload = {key: payload.get(key) for key in FinanceTransactionInput.model_fields if key in payload}
    return FinanceTransactionInput.model_validate(safe_payload)


def public_account_payload(payload: dict[str, Any]) -> dict[str, Any]:
    items = []
    for raw in payload.get("items") or []:
        if not isinstance(raw, dict):
            continue
        items.append(
            {
                "name": str(raw.get("name") or "")[:40],
                "label": str(raw.get("label") or raw.get("name") or "")[:80],
                "balance": int(raw.get("balance") or 0),
                "currency": str(raw.get("currency") or payload.get("currency") or "IDR")[:8],
            }
        )
    return {
        "items": items,
        "total_balance": int(payload.get("total_balance") or 0),
        "currency": str(payload.get("currency") or "IDR")[:8],
    }


def public_transaction_payload(payload: dict[str, Any]) -> dict[str, Any]:
    safe_items = []
    for raw in payload.get("items") or []:
        if not isinstance(raw, dict):
            continue
        transaction = transaction_from_upstream(raw)
        if not transaction:
            continue
        safe_items.append(
            {
                "id": str(raw.get("id") or "")[:80],
                **transaction.model_dump(),
                "occurred_at": str(raw.get("occurred_at") or transaction.occurred_at or "")[:64],
                "created_at": str(raw.get("created_at") or "")[:64],
            }
        )
    return {"items": safe_items}


def encode_receipt(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("ascii")

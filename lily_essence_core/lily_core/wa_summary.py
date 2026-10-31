"""Stateless inbox summaries; no chat history, tools, or voice side effects."""

import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from .providers import _get_compat_openai_client
from .settings import settings
from .prompt_store import get_prompt

router = APIRouter()


class InboxSummaryRequest(BaseModel):
    contact_name: str = Field(default="Unknown", max_length=100)
    message: str = Field(min_length=1, max_length=12000)


@router.post("/api/wa/inbox/summarize")
def summarize_inbox(request: InboxSummaryRequest):
    """Run bounded synchronous inference in FastAPI's worker thread pool."""
    if not request.message.strip():
        raise HTTPException(422, "Message must not be blank.")
    try:
        client = _get_compat_openai_client().with_options(timeout=12.0, max_retries=0)
        response = client.chat.completions.create(
            model=settings.openai_compat_brain_model,
            messages=[
                {"role": "system", "content": get_prompt("wa_summary")},
                {"role": "user", "content": json.dumps(request.model_dump(), ensure_ascii=False)},
            ],
            temperature=0.0,
            max_tokens=160,
            extra_body={"thinking": {"type": "disabled"}},
        )
        summary = (response.choices[0].message.content or "").strip()
        if not summary:
            raise ValueError("Empty summary")
        return {"summary": summary[:500], "model": settings.openai_compat_brain_model}
    except Exception:
        # Do not expose upstream credentials or private message bodies in errors.
        raise HTTPException(503, "Inbox summary provider unavailable.") from None

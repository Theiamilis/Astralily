"""Owner-authenticated routes; mounted behind Core's owner middleware."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from .prompt_store import prompt_snapshot, update_prompt

router = APIRouter()


class PromptUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(max_length=80)
    text: str | None = Field(..., max_length=16000)
    revision: str = Field(min_length=64, max_length=64)


@router.get("/api/prompts")
def list_prompts():
    try:
        return prompt_snapshot()
    except (OSError, ValueError):
        raise HTTPException(503, "Prompt storage unavailable; inference uses defaults.") from None


@router.post("/api/prompts")
def save_prompt(request: PromptUpdate):
    try:
        return update_prompt(request.id, request.text, request.revision)
    except RuntimeError as error:
        raise HTTPException(409, str(error)) from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except OSError:
        raise HTTPException(503, "Could not save prompt overrides.") from None

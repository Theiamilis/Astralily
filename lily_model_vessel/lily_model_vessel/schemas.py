from pydantic import BaseModel, Field


class RenameModelRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


class ExpressionUpdate(BaseModel):
    raw_name: str = Field(min_length=1, max_length=160)
    display_name: str = Field(min_length=1, max_length=80)
    semantic_key: str | None = Field(default=None, max_length=40)
    default_active: bool = False


class ExpressionMappingRequest(BaseModel):
    expressions: list[ExpressionUpdate]


class AssignmentRequest(BaseModel):
    target: str = Field(min_length=1, max_length=40)

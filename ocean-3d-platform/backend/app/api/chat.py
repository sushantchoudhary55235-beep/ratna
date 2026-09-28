import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.schemas.chat import (
    ChatRequest,
    ChatRequestWithHistory,
    ChatResponse,
)
from app.services.gemini_service import ask_oceanai, generate_ai_response


logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/v1/chat",
    tags=["OceanAI"],
)


@router.post("", response_model=ChatResponse)
def chat(request: ChatRequestWithHistory):
    """OceanAI chat endpoint.

    Accepts a question about ocean science and returns a Gemini-generated answer.
    Optionally accepts RATNAKAR data context for data-aware responses.
    """
    try:
        # Convert context to dict if provided
        context_dict = None
        if request.context:
            context_dict = {
                "region": request.context.region,
                "latitude": request.context.latitude,
                "longitude": request.context.longitude,
                "depth": request.context.depth,
                "variable": request.context.variable,
            }

        answer = ask_oceanai(
            request.question,
            context=context_dict,
            conversation_history=request.conversation_history,
        )

        return ChatResponse(answer=answer)

    except RuntimeError as exc:
        # Log the actual error but return a safe message to the client
        logger.error(f"Gemini error: {exc}")
        raise HTTPException(
            status_code=500,
            detail="OceanAI service error. Please try again later.",
        )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise

    except Exception as exc:
        # Log the actual error but return a safe message to the client
        logger.error(f"Unexpected chat error: {exc}")
        raise HTTPException(
            status_code=500,
            detail="OceanAI is temporarily unavailable.",
        )


class ReportAssistantRequest(BaseModel):
    """Request for the report-grounded AI assistant.

    ``report_context`` carries only fields the Report Analysis view actually
    computes (audited): title metadata, location/time/depth labels, and the
    per-variable statistics objects. Unknown extra keys are ignored.
    """

    question: str = Field(..., min_length=1, max_length=2000)
    report_context: dict = Field(default_factory=dict)
    conversation_history: list = Field(default_factory=list)

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question cannot be empty or whitespace-only")
        return value


class ReportAssistantResponse(BaseModel):
    response: str
    status: str


@router.post("/report", response_model=ReportAssistantResponse)
def report_ai_assistant(request: ReportAssistantRequest) -> ReportAssistantResponse:
    """Report-specific AI assistant grounded ONLY in the open report's data."""
    try:
        rc = request.report_context or {}
        context_parts: list[str] = []

        if rc.get("title"):
            context_parts.append(f"Report Title: {rc['title']}")
        if rc.get("region"):
            context_parts.append(f"Region: {rc['region']}")
        if rc.get("location"):
            context_parts.append(f"Location: {rc['location']}")
        if rc.get("analysis_date"):
            context_parts.append(f"Analysis Date/Time: {rc['analysis_date']}")
        if rc.get("depth_label"):
            context_parts.append(f"Depth Selection: {rc['depth_label']}")
        if rc.get("data_source"):
            context_parts.append(f"Data Source: {rc['data_source']}")

        # Per-variable statistics objects keyed by variable name
        # ({min, max, mean, current, unit, observation_count}).
        variables = rc.get("variables")
        if isinstance(variables, dict):
            labels = {
                "temperature": "Temperature",
                "salinity": "Salinity",
                "currents": "Currents",
                "chlorophyll": "Chlorophyll-a",
            }
            for key, label in labels.items():
                stats = variables.get(key)
                if not isinstance(stats, dict):
                    continue
                unit = stats.get("unit", "")
                if stats.get("current") is not None:
                    context_parts.append(f"{label} current value: {stats['current']} {unit}")
                if stats.get("min") is not None:
                    context_parts.append(f"{label} minimum: {stats['min']} {unit}")
                if stats.get("max") is not None:
                    context_parts.append(f"{label} maximum: {stats['max']} {unit}")
                if stats.get("mean") is not None:
                    context_parts.append(f"{label} mean: {stats['mean']} {unit}")
                if stats.get("observation_count") is not None:
                    context_parts.append(f"{label} data points: {stats['observation_count']}")

        if not context_parts:
            context_string = "No report data available."
        else:
            context_string = "\n".join(context_parts)

        answer = generate_ai_response(
            question=request.question,
            context=context_string,
            conversation_history=request.conversation_history,
        )
        return ReportAssistantResponse(response=answer, status="success")

    except RuntimeError as exc:
        logger.error(f"Report assistant Gemini error: {exc}")
        return ReportAssistantResponse(
            response="AI Assistant is temporarily unavailable.",
            status="error",
        )

    except Exception as exc:
        logger.error(f"Unexpected report assistant error: {exc}")
        return ReportAssistantResponse(
            response="AI Assistant is temporarily unavailable.",
            status="error",
        )
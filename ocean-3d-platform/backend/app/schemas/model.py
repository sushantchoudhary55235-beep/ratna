"""Pydantic response schemas for the ocean model field endpoint."""

from pydantic import BaseModel, Field


class ModelFieldPoint(BaseModel):
    """A single grid point with its geographic position and value."""

    latitude: float
    longitude: float
    value: float


class SliceStatistics(BaseModel):
    """Statistics of the FULL-resolution slice (computed before any
    downsampling, from finite ocean values only — NaN/land excluded).
    min/max/mean are null when the slice contains no valid ocean cells."""

    min: float | None = None
    max: float | None = None
    mean: float | None = None
    valid_count: int
    missing_count: int


class ModelFieldResponse(BaseModel):
    """Response for GET /api/v1/model-field."""

    variable: str
    unit: str
    depth: float
    time: str
    source: str
    points: list[ModelFieldPoint]
    requested_depth_m: float | None = Field(
        default=None,
        description="Depth originally requested by the client (m)",
    )
    depth_index: int | None = Field(
        default=None,
        description="0-based index of the selected depth level in the model's depth axis",
    )
    depth_count: int | None = Field(
        default=None,
        description="Total number of depth levels in the model",
    )
    statistics: SliceStatistics | None = Field(
        default=None,
        description="Full-grid statistics of the selected slice (finite values only)",
    )


class ModelCapabilitiesResponse(BaseModel):
    """Actual selectable axes and variables discovered from the model NetCDF."""

    source: str
    variables: dict[str, str]
    depths_m: list[float]
    timestamps: list[str]
    time_steps: int

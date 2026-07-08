"""Game state schema and serialization.

Defines the canonical in-memory and wire representations for a deterministic
1v1 street basketball simulation snapshot. Fixed-point arithmetic (6 decimal
places via Python's Decimal) guarantees that two runs producing equivalent
game states also produce byte-identical JSON, regardless of how intermediate
values were computed.

No physics, no AI — only the data contract.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal, getcontext
from enum import Enum
from pathlib import Path
from typing import Any

getcontext().prec = 28
_SCALE = Decimal("0.000001")

GAME_STATE_SCHEMA_PATH = Path(__file__).parent / "schemas" / "game_state.schema.json"


def fp(value: int | float | str | Decimal) -> Decimal:
    """Quantize any numeric input to 6-place fixed-point.

    Using str() as the intermediate prevents silent float-to-Decimal
    rounding errors (Decimal(0.1) != Decimal("0.1")).
    """
    return Decimal(str(value)).quantize(_SCALE, rounding=ROUND_HALF_EVEN)


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class PossessionState(str, Enum):
    ATTACKER = "ATTACKER"
    BALL_IN_FLIGHT = "BALL_IN_FLIGHT"
    LOOSE_BALL = "LOOSE_BALL"


class DefenderMode(str, Enum):
    GUARDING = "GUARDING"
    SHADING_LEFT = "SHADING_LEFT"
    SHADING_RIGHT = "SHADING_RIGHT"
    CONTESTING = "CONTESTING"
    RECOVERING = "RECOVERING"


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Vec2:
    """2D vector with fixed-point components."""

    x: Decimal
    y: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(self, "x", fp(self.x))
        object.__setattr__(self, "y", fp(self.y))

    def to_dict(self) -> dict[str, str]:
        return {"x": str(self.x), "y": str(self.y)}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Vec2:
        return cls(x=fp(d["x"]), y=fp(d["y"]))


@dataclass(frozen=True)
class Kinematics:
    """Position, velocity, and acceleration triplet for one entity."""

    position: Vec2
    velocity: Vec2
    acceleration: Vec2

    def to_dict(self) -> dict[str, Any]:
        return {
            "position": self.position.to_dict(),
            "velocity": self.velocity.to_dict(),
            "acceleration": self.acceleration.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Kinematics:
        return cls(
            position=Vec2.from_dict(d["position"]),
            velocity=Vec2.from_dict(d["velocity"]),
            acceleration=Vec2.from_dict(d["acceleration"]),
        )


# ---------------------------------------------------------------------------
# Defender belief state
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DefenderBelief:
    """The defender's internal calculus at this frame.

    predicted_intercept: where the defender predicts it must be to cut off
        the attacker, in court-space coordinates.
    threat_level: [0.000000, 1.000000] — composite urgency score. 0 = passive
        shadow, 1 = imminent scoring attempt that must be contested now.
    mode: current behavioral stance.
    """

    predicted_intercept: Vec2
    threat_level: Decimal
    mode: DefenderMode

    def __post_init__(self) -> None:
        object.__setattr__(self, "threat_level", fp(self.threat_level))

    def to_dict(self) -> dict[str, Any]:
        return {
            "predicted_intercept": self.predicted_intercept.to_dict(),
            "threat_level": str(self.threat_level),
            "mode": self.mode.value,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DefenderBelief:
        return cls(
            predicted_intercept=Vec2.from_dict(d["predicted_intercept"]),
            threat_level=fp(d["threat_level"]),
            mode=DefenderMode(d["mode"]),
        )


# ---------------------------------------------------------------------------
# Entity states
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AttackerState:
    kinematics: Kinematics

    def to_dict(self) -> dict[str, Any]:
        return {"kinematics": self.kinematics.to_dict()}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> AttackerState:
        return cls(kinematics=Kinematics.from_dict(d["kinematics"]))


@dataclass(frozen=True)
class DefenderState:
    kinematics: Kinematics
    belief: DefenderBelief

    def to_dict(self) -> dict[str, Any]:
        return {
            "kinematics": self.kinematics.to_dict(),
            "belief": self.belief.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> DefenderState:
        return cls(
            kinematics=Kinematics.from_dict(d["kinematics"]),
            belief=DefenderBelief.from_dict(d["belief"]),
        )


# ---------------------------------------------------------------------------
# Ball state
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BallState:
    """Ball position, motion, and trajectory parameters.

    launch_angle and spin are only meaningful when possession == BALL_IN_FLIGHT,
    but they are always present in the snapshot so the wire format stays uniform.
    spin is in [-1.0, 1.0]: negative = backspin, positive = topspin.
    launch_angle is in radians.
    """

    possession: PossessionState
    position: Vec2
    velocity: Vec2
    launch_angle: Decimal
    spin: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(self, "launch_angle", fp(self.launch_angle))
        object.__setattr__(self, "spin", fp(self.spin))

    def to_dict(self) -> dict[str, Any]:
        return {
            "possession": self.possession.value,
            "position": self.position.to_dict(),
            "velocity": self.velocity.to_dict(),
            "launch_angle": str(self.launch_angle),
            "spin": str(self.spin),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> BallState:
        return cls(
            possession=PossessionState(d["possession"]),
            position=Vec2.from_dict(d["position"]),
            velocity=Vec2.from_dict(d["velocity"]),
            launch_angle=fp(d["launch_angle"]),
            spin=fp(d["spin"]),
        )


# ---------------------------------------------------------------------------
# Top-level snapshot
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GameSnapshot:
    """Complete deterministic state of the 1v1 match at a single frame.

    frame: monotonically increasing integer. Frame 0 is the initial state.
    Canonical JSON (sort_keys=True) is the wire format for cross-system
    comparisons; two logically equal snapshots must produce identical bytes.
    """

    frame: int
    attacker: AttackerState
    defender: DefenderState
    ball: BallState

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame": self.frame,
            "attacker": self.attacker.to_dict(),
            "defender": self.defender.to_dict(),
            "ball": self.ball.to_dict(),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GameSnapshot:
        return cls(
            frame=int(d["frame"]),
            attacker=AttackerState.from_dict(d["attacker"]),
            defender=DefenderState.from_dict(d["defender"]),
            ball=BallState.from_dict(d["ball"]),
        )

    @classmethod
    def from_json(cls, s: str) -> GameSnapshot:
        return cls.from_dict(json.loads(s))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_snapshot(snapshot: GameSnapshot) -> None:
    """Assert schema validity and domain invariants.

    Raises jsonschema.ValidationError for schema violations,
    ValueError for domain invariant violations.
    """
    import jsonschema

    schema = json.loads(GAME_STATE_SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.validate(instance=snapshot.to_dict(), schema=schema)

    tl = snapshot.defender.belief.threat_level
    if not (fp("0.0") <= tl <= fp("1.0")):
        raise ValueError(f"threat_level {tl!r} outside [0, 1]")

    spin = snapshot.ball.spin
    if not (fp("-1.0") <= spin <= fp("1.0")):
        raise ValueError(f"spin {spin!r} outside [-1, 1]")

"""Attacker intent state-machine.

Pure, stateless function: given a GameSnapshot, returns the attacker's
target Kinematics for the next frame. Position integration is the frame
stepper's responsibility — this module only decides velocity.

Behavioral rules (priority order)
----------------------------------
1. No possession (BALL_IN_FLIGHT or LOOSE_BALL): bleed velocity via
   DECEL_FACTOR. The attacker cannot self-accelerate without the ball.
2. Defender threat > SHOOT_THREAT_THRESHOLD: lateral evasion — step
   perpendicular to the basket drive vector to create separation.
3. Otherwise: drive toward BASKET by stepping velocity in that direction.
All velocity components are clamped to ±MAX_VEL_COMPONENT after each step,
keeping speed bounded without requiring sqrt.
"""

from __future__ import annotations

from decimal import Decimal

from engine.defender_transition import BASKET
from engine.game_state import (
    GameSnapshot,
    Kinematics,
    PossessionState,
    Vec2,
    fp,
)

DRIVE_STEP = fp("0.500000")
DECEL_FACTOR = fp("0.850000")
SHOOT_THREAT_THRESHOLD = fp("0.750000")
MAX_VEL_COMPONENT = fp("3.000000")

_ZERO = Decimal("0")


def _clamp(value: Decimal, lo: Decimal, hi: Decimal) -> Decimal:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def next_attacker_intent(snapshot: GameSnapshot) -> Kinematics:
    """Pure, stateless attacker intent for the next frame.

    Returns updated Kinematics. The position field is carried through
    unchanged — the frame stepper applies the returned velocity to move it.
    """
    curr = snapshot.attacker.kinematics

    if snapshot.ball.possession != PossessionState.ATTACKER:
        return Kinematics(
            position=curr.position,
            velocity=Vec2(
                fp(curr.velocity.x * DECEL_FACTOR),
                fp(curr.velocity.y * DECEL_FACTOR),
            ),
            acceleration=curr.acceleration,
        )

    dx = BASKET.x - curr.position.x
    dy = BASKET.y - curr.position.y

    if snapshot.defender.belief.threat_level > SHOOT_THREAT_THRESHOLD:
        # Perpendicular to basket drive vector: (-dy, dx)
        target_x = -dy
        target_y = dx
    else:
        target_x = dx
        target_y = dy

    step_x = DRIVE_STEP if target_x >= _ZERO else -DRIVE_STEP
    step_y = DRIVE_STEP if target_y >= _ZERO else -DRIVE_STEP

    return Kinematics(
        position=curr.position,
        velocity=Vec2(
            _clamp(fp(curr.velocity.x + step_x), -MAX_VEL_COMPONENT, MAX_VEL_COMPONENT),
            _clamp(fp(curr.velocity.y + step_y), -MAX_VEL_COMPONENT, MAX_VEL_COMPONENT),
        ),
        acceleration=curr.acceleration,
    )

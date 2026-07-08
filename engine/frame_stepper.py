"""Deterministic frame stepper — the master simulation tick.

step_frame(snapshot) -> GameSnapshot

Pure and stateless: the input is never modified, identical inputs always
produce identical outputs. One call advances the simulation by exactly one
frame using explicit Euler integration throughout.

Evaluation order (strict, no ordering bias between agents)
-----------------------------------------------------------
1. Attacker intent (new velocity) — reads ONLY from current snapshot.
2. Defender belief update          — reads ONLY from current snapshot.
   Steps 1 and 2 run from the same snapshot state so neither agent has
   advance knowledge of the other's frame-N update.
3. Integrate attacker position: pos += new_velocity; clamp to court.
4. Integrate defender position: pos += current_velocity; clamp to court.
   The defender's velocity is not updated by this module — that is a
   separate planner concern. The belief's predicted_intercept encodes
   WHERE the defender should go; a velocity planner would turn that into
   velocity. For now the defender moves at whatever velocity the snapshot
   already carries.
5. Resolve ball state from possession.
6. Reconstruct and return new immutable GameSnapshot (frame + 1).
"""

from __future__ import annotations

from decimal import Decimal

from engine.attacker_behavior import next_attacker_intent
from engine.defender_transition import next_defender_belief
from engine.game_state import (
    AttackerState,
    BallState,
    DefenderState,
    GameSnapshot,
    Kinematics,
    PossessionState,
    Vec2,
    fp,
)

# Court spatial bounds (half-court 1v1, units match defender_transition.py)
COURT_MIN_X = fp("-15.000000")
COURT_MAX_X = fp("15.000000")
COURT_MIN_Y = fp("-5.000000")
COURT_MAX_Y = fp("5.000000")

# Ball physics
GRAVITY = fp("0.100000")       # vertical velocity drop per frame when in flight
BALL_FRICTION = fp("0.900000") # velocity retention on loose ball per frame


def _clamp(value: Decimal, lo: Decimal, hi: Decimal) -> Decimal:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def step_frame(snapshot: GameSnapshot) -> GameSnapshot:
    """Advance the simulation by one frame. Returns a new GameSnapshot."""

    # --- 1 & 2: Compute agent updates from the immutable current snapshot ---
    next_att_kin = next_attacker_intent(snapshot)
    next_def_belief = next_defender_belief(snapshot)

    # --- 3: Integrate attacker position ---
    att_new_pos = Vec2(
        _clamp(fp(snapshot.attacker.kinematics.position.x + next_att_kin.velocity.x), COURT_MIN_X, COURT_MAX_X),
        _clamp(fp(snapshot.attacker.kinematics.position.y + next_att_kin.velocity.y), COURT_MIN_Y, COURT_MAX_Y),
    )

    # --- 4: Integrate defender position ---
    def_new_pos = Vec2(
        _clamp(fp(snapshot.defender.kinematics.position.x + snapshot.defender.kinematics.velocity.x), COURT_MIN_X, COURT_MAX_X),
        _clamp(fp(snapshot.defender.kinematics.position.y + snapshot.defender.kinematics.velocity.y), COURT_MIN_Y, COURT_MAX_Y),
    )

    # --- 5: Resolve ball state ---
    old_ball = snapshot.ball
    possession = old_ball.possession

    if possession == PossessionState.ATTACKER:
        new_ball = BallState(
            possession=possession,
            position=att_new_pos,
            velocity=next_att_kin.velocity,
            launch_angle=old_ball.launch_angle,
            spin=old_ball.spin,
        )
    elif possession == PossessionState.BALL_IN_FLIGHT:
        new_ball_vel = Vec2(
            old_ball.velocity.x,
            fp(old_ball.velocity.y - GRAVITY),
        )
        new_ball = BallState(
            possession=possession,
            position=Vec2(
                fp(old_ball.position.x + new_ball_vel.x),
                fp(old_ball.position.y + new_ball_vel.y),
            ),
            velocity=new_ball_vel,
            launch_angle=old_ball.launch_angle,
            spin=old_ball.spin,
        )
    else:  # LOOSE_BALL
        new_ball_vel = Vec2(
            fp(old_ball.velocity.x * BALL_FRICTION),
            fp(old_ball.velocity.y * BALL_FRICTION),
        )
        new_ball = BallState(
            possession=possession,
            position=Vec2(
                fp(old_ball.position.x + new_ball_vel.x),
                fp(old_ball.position.y + new_ball_vel.y),
            ),
            velocity=new_ball_vel,
            launch_angle=old_ball.launch_angle,
            spin=old_ball.spin,
        )

    # --- 6: Reconstruct immutable snapshot ---
    return GameSnapshot(
        frame=snapshot.frame + 1,
        attacker=AttackerState(
            kinematics=Kinematics(
                position=att_new_pos,
                velocity=next_att_kin.velocity,
                acceleration=next_att_kin.acceleration,
            )
        ),
        defender=DefenderState(
            kinematics=Kinematics(
                position=def_new_pos,
                velocity=snapshot.defender.kinematics.velocity,
                acceleration=snapshot.defender.kinematics.acceleration,
            ),
            belief=next_def_belief,
        ),
        ball=new_ball,
    )

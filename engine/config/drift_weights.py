"""Externalized weight configuration for the game-track drift scorer.

Changing tuning parameters here leaves the observer and causal spine untouched.
All weights must sum to 1.0 for the composite score to be normalized.
"""

from decimal import Decimal

DEFAULT_DRIFT_WEIGHTS: dict[str, Decimal] = {
    "position": Decimal("0.400000"),
    "velocity": Decimal("0.100000"),
    "ball":     Decimal("0.250000"),
    "belief":   Decimal("0.150000"),
    "threat":   Decimal("0.100000"),
}

"""Mutation campaign harness — calibrates the replay verification pipeline.

Runs 50 controlled perturbations against a pristine replay bundle and records
the verification outcome for each mutation.  The resulting CampaignReport
quantifies the detection rate and classification accuracy of the pipeline,
establishing a recoverability safety baseline.

Mutation taxonomy (10 mutations per class):
    INTEGRITY    — byte-level corruption without hash update (cryptographic layer)
    TEMPORAL     — frame ordering / alignment perturbations (structural layer)
    NUMERICAL    — kinematic coordinate mutations with rehash (engine layer)
    SEMANTIC     — belief-state mutations with rehash (policy layer)
    ENVIRONMENT  — version and metadata perturbations (governance layer)

Each mutation applies exactly one perturbation to an otherwise pristine bundle
in an isolated scratch directory.  The pristine bundle is never modified.

run_mutation_campaign(pristine_dir, campaign_dir, engine_version, timestamp)
    -> CampaignReport

write_campaign_archive(report, archive_dir)
    Writes campaign_metadata.json, results.json, and diagnostics.json.
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from engine.replay_verifier import VerificationResult, verify_replay_run

_V = VerificationResult  # module-level shorthand


# ---------------------------------------------------------------------------
# Public data contracts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MutationResult:
    """Immutable record of one mutation trial."""

    mutation_id: str
    taxonomy_class: str
    description: str
    expected_result: VerificationResult
    observed_result: VerificationResult
    detected: bool       # verifier returned non-VERIFIED
    correct_code: bool   # verifier returned the expected classification code
    execution_ms: float


@dataclass(frozen=True)
class CampaignReport:
    """Aggregate calibration report for the full 50-mutation sweep."""

    campaign_id: str
    source_bundle_hash: str    # sha256 of pristine truth_track.json
    engine_version: str
    timestamp: str
    mutation_count: int
    detected_count: int        # mutations where verifier returned non-VERIFIED
    correct_code_count: int    # mutations where observed == expected
    detection_rate: float      # detected_count / mutation_count
    classification_accuracy: float  # correct_code_count / mutation_count
    results: tuple             # tuple[MutationResult, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "results", tuple(self.results))


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _copy_bundle(src: Path, dst: Path) -> None:
    """Copy all files from src into dst (dst must already exist)."""
    for f in src.iterdir():
        (dst / f.name).write_bytes(f.read_bytes())


def _read_manifest(d: Path) -> dict:
    return json.loads((d / "manifest.json").read_text(encoding="utf-8"))


def _write_manifest(d: Path, m: dict) -> None:
    (d / "manifest.json").write_text(
        json.dumps(m, sort_keys=True, indent=2), encoding="utf-8"
    )


def _update_manifest_hashes(
    d: Path,
    *,
    seed_bytes: bytes | None = None,
    truth_bytes: bytes | None = None,
) -> None:
    m = _read_manifest(d)
    if seed_bytes is not None:
        m["seed_sha256"] = hashlib.sha256(seed_bytes).hexdigest()
    if truth_bytes is not None:
        m["truth_track_sha256"] = hashlib.sha256(truth_bytes).hexdigest()
    _write_manifest(d, m)


def _read_track(d: Path) -> list:
    return json.loads((d / "truth_track.json").read_bytes().decode("utf-8"))


def _write_track(d: Path, track: list, *, rehash: bool = True) -> None:
    new_bytes = json.dumps(track, sort_keys=True, indent=2).encode("utf-8")
    (d / "truth_track.json").write_bytes(new_bytes)
    if rehash:
        _update_manifest_hashes(d, truth_bytes=new_bytes)


def _read_seed(d: Path) -> dict:
    return json.loads((d / "seed_snapshot.json").read_bytes().decode("utf-8"))


def _write_seed(d: Path, seed: dict, *, rehash: bool = True) -> None:
    new_bytes = json.dumps(seed, sort_keys=True, indent=2).encode("utf-8")
    (d / "seed_snapshot.json").write_bytes(new_bytes)
    if rehash:
        _update_manifest_hashes(d, seed_bytes=new_bytes)


def _run_mutation(
    mutation_id: str,
    taxonomy_class: str,
    description: str,
    expected: VerificationResult,
    pristine_dir: Path,
    campaign_dir: Path,
    engine_version: str,
    mutate: Callable[[Path], None],
) -> MutationResult:
    """Copy pristine bundle, apply mutation, verify, and return result."""
    mut_dir = campaign_dir / mutation_id
    mut_dir.mkdir(parents=True, exist_ok=True)
    _copy_bundle(pristine_dir, mut_dir)
    mutate(mut_dir)
    t0 = time.perf_counter()
    observed = verify_replay_run(mut_dir, engine_version)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return MutationResult(
        mutation_id=mutation_id,
        taxonomy_class=taxonomy_class,
        description=description,
        expected_result=expected,
        observed_result=observed,
        detected=(observed != _V.VERIFIED),
        correct_code=(observed == expected),
        execution_ms=elapsed_ms,
    )


# ---------------------------------------------------------------------------
# INTEGRITY mutations (byte-level corruption, no hash update)
# ---------------------------------------------------------------------------


def _int01_flip_truth_byte_30(d: Path) -> None:
    b = (d / "truth_track.json").read_bytes()
    (d / "truth_track.json").write_bytes(b[:30] + bytes([b[30] ^ 0x01]) + b[31:])


def _int02_flip_truth_byte_100(d: Path) -> None:
    b = (d / "truth_track.json").read_bytes()
    (d / "truth_track.json").write_bytes(b[:100] + bytes([b[100] ^ 0x01]) + b[101:])


def _int03_truncate_truth_20_bytes(d: Path) -> None:
    (d / "truth_track.json").write_bytes(
        (d / "truth_track.json").read_bytes()[:20]
    )


def _int04_empty_truth_track(d: Path) -> None:
    (d / "truth_track.json").write_bytes(b"")


def _int05_flip_seed_byte_10(d: Path) -> None:
    b = (d / "seed_snapshot.json").read_bytes()
    (d / "seed_snapshot.json").write_bytes(b[:10] + bytes([b[10] ^ 0x01]) + b[11:])


def _int06_replace_seed_tampered(d: Path) -> None:
    (d / "seed_snapshot.json").write_bytes(b"tampered")


def _int07_append_null_bytes(d: Path) -> None:
    b = (d / "truth_track.json").read_bytes()
    (d / "truth_track.json").write_bytes(b + b"\x00" * 100)


def _int08_replace_truth_ff(d: Path) -> None:
    (d / "truth_track.json").write_bytes(b"\xff" * 500)


def _int09_prepend_garbage_to_seed(d: Path) -> None:
    b = (d / "seed_snapshot.json").read_bytes()
    (d / "seed_snapshot.json").write_bytes(b"CORRUPTED:" + b)


def _int10_zero_truth_hash_in_manifest(d: Path) -> None:
    m = _read_manifest(d)
    m["truth_track_sha256"] = "0" * 64
    _write_manifest(d, m)


def _run_integrity_mutations(
    pristine_dir: Path, campaign_dir: Path, ev: str
) -> list[MutationResult]:
    specs = [
        ("INT-01", "Flip bit at byte 30 of truth_track.json (no hash update)",
         _V.HASH_FAILURE, _int01_flip_truth_byte_30),
        ("INT-02", "Flip bit at byte 100 of truth_track.json (no hash update)",
         _V.HASH_FAILURE, _int02_flip_truth_byte_100),
        ("INT-03", "Truncate truth_track.json to 20 bytes",
         _V.HASH_FAILURE, _int03_truncate_truth_20_bytes),
        ("INT-04", "Replace truth_track.json with empty file",
         _V.HASH_FAILURE, _int04_empty_truth_track),
        ("INT-05", "Flip bit at byte 10 of seed_snapshot.json (no hash update)",
         _V.SEED_MISMATCH, _int05_flip_seed_byte_10),
        ("INT-06", "Replace seed_snapshot.json with b'tampered'",
         _V.SEED_MISMATCH, _int06_replace_seed_tampered),
        ("INT-07", "Append 100 null bytes to truth_track.json",
         _V.HASH_FAILURE, _int07_append_null_bytes),
        ("INT-08", "Replace truth_track.json with 0xFF bytes",
         _V.HASH_FAILURE, _int08_replace_truth_ff),
        ("INT-09", "Prepend garbage prefix to seed_snapshot.json",
         _V.SEED_MISMATCH, _int09_prepend_garbage_to_seed),
        ("INT-10", "Zero truth_track_sha256 in manifest (manifest-only tampering)",
         _V.HASH_FAILURE, _int10_zero_truth_hash_in_manifest),
    ]
    return [
        _run_mutation(mid, "INTEGRITY", desc, exp, pristine_dir, campaign_dir, ev, fn)
        for mid, desc, exp, fn in specs
    ]


# ---------------------------------------------------------------------------
# TEMPORAL mutations (frame alignment / ordering, truth_track rehashed)
# ---------------------------------------------------------------------------


def _tmp01_change_track0_frame_to_99(d: Path) -> None:
    track = _read_track(d)
    track[0]["frame"] = 99
    _write_track(d, track)


def _tmp02_change_track1_frame_to_99(d: Path) -> None:
    track = _read_track(d)
    track[1]["frame"] = 99
    _write_track(d, track)


def _tmp03_reverse_track(d: Path) -> None:
    track = _read_track(d)
    _write_track(d, list(reversed(track)))


def _tmp04_swap_frames_0_and_1(d: Path) -> None:
    track = _read_track(d)
    track[0], track[1] = track[1], track[0]
    _write_track(d, track)


def _tmp05_change_seed_frame_to_99(d: Path) -> None:
    seed = _read_seed(d)
    seed["frame"] = 99
    _write_seed(d, seed)


def _tmp06_replace_frame2_with_copy_of_frame1(d: Path) -> None:
    track = _read_track(d)
    track[2] = copy.deepcopy(track[1])  # frame[2].frame == 1 (duplicate)
    _write_track(d, track)


def _tmp07_append_copy_of_last_frame(d: Path) -> None:
    track = _read_track(d)
    track.append(copy.deepcopy(track[-1]))  # trailing frame has same frame ID
    _write_track(d, track)


def _tmp08_remove_frame_0(d: Path) -> None:
    track = _read_track(d)
    _write_track(d, track[1:])  # now starts at frame 1, mismatches seed.frame=0


def _tmp09_increment_all_frame_ids(d: Path) -> None:
    track = _read_track(d)
    for f in track:
        f["frame"] += 1  # frame[0] becomes 1, mismatches seed.frame=0
    _write_track(d, track)


def _tmp10_change_track3_frame_to_99(d: Path) -> None:
    track = _read_track(d)
    track[3]["frame"] = 99  # mid-track alignment break
    _write_track(d, track)


def _run_temporal_mutations(
    pristine_dir: Path, campaign_dir: Path, ev: str
) -> list[MutationResult]:
    specs = [
        ("TMP-01", "truth_track[0].frame → 99 (seed-track frame alignment break)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp01_change_track0_frame_to_99),
        ("TMP-02", "truth_track[1].frame → 99 (timeline gap after frame 0)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp02_change_track1_frame_to_99),
        ("TMP-03", "Reverse truth_track frame order",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp03_reverse_track),
        ("TMP-04", "Swap truth_track[0] and truth_track[1]",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp04_swap_frames_0_and_1),
        ("TMP-05", "seed.frame → 99 (seed mismatches archived track[0].frame=0)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp05_change_seed_frame_to_99),
        ("TMP-06", "truth_track[2] replaced with copy of truth_track[1] (duplicate frame IDs)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp06_replace_frame2_with_copy_of_frame1),
        ("TMP-07", "Append copy of last frame to truth_track (trailing frame ID mismatch)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp07_append_copy_of_last_frame),
        ("TMP-08", "Remove frame 0 from truth_track (now starts at frame 1)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp08_remove_frame_0),
        ("TMP-09", "Increment all truth_track frame IDs by 1",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp09_increment_all_frame_ids),
        ("TMP-10", "truth_track[3].frame → 99 (mid-track alignment break)",
         _V.FRAME_ALIGNMENT_FAILURE, _tmp10_change_track3_frame_to_99),
    ]
    return [
        _run_mutation(mid, "TEMPORAL", desc, exp, pristine_dir, campaign_dir, ev, fn)
        for mid, desc, exp, fn in specs
    ]


# ---------------------------------------------------------------------------
# NUMERICAL mutations (kinematic coordinates, truth_track rehashed)
# ---------------------------------------------------------------------------


def _num01_track1_attacker_pos_x(d: Path) -> None:
    track = _read_track(d)
    track[1]["attacker"]["kinematics"]["position"]["x"] = "99.000000"
    _write_track(d, track)


def _num02_track1_attacker_pos_y(d: Path) -> None:
    track = _read_track(d)
    track[1]["attacker"]["kinematics"]["position"]["y"] = "99.000000"
    _write_track(d, track)


def _num03_track1_attacker_vel_x(d: Path) -> None:
    track = _read_track(d)
    track[1]["attacker"]["kinematics"]["velocity"]["x"] = "99.000000"
    _write_track(d, track)


def _num04_track1_attacker_vel_y(d: Path) -> None:
    track = _read_track(d)
    track[1]["attacker"]["kinematics"]["velocity"]["y"] = "99.000000"
    _write_track(d, track)


def _num05_track1_defender_pos_x(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["kinematics"]["position"]["x"] = "99.000000"
    _write_track(d, track)


def _num06_track1_defender_pos_y(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["kinematics"]["position"]["y"] = "99.000000"
    _write_track(d, track)


def _num07_track2_attacker_pos_x(d: Path) -> None:
    track = _read_track(d)
    track[2]["attacker"]["kinematics"]["position"]["x"] = "99.000000"
    _write_track(d, track)


def _num08_track1_ball_pos_x(d: Path) -> None:
    track = _read_track(d)
    track[1]["ball"]["position"]["x"] = "99.000000"
    _write_track(d, track)


def _num09_track1_ball_pos_y(d: Path) -> None:
    track = _read_track(d)
    track[1]["ball"]["position"]["y"] = "99.000000"
    _write_track(d, track)


def _num10_track0_attacker_pos_x(d: Path) -> None:
    # Mutate seed-frame copy in truth_track only; actual seed file unchanged.
    # Archived track[0] diverges from reconstructed track[0] = seed.
    track = _read_track(d)
    track[0]["attacker"]["kinematics"]["position"]["x"] = "99.000000"
    _write_track(d, track)


def _run_numerical_mutations(
    pristine_dir: Path, campaign_dir: Path, ev: str
) -> list[MutationResult]:
    specs = [
        ("NUM-01", "truth_track[1] attacker position.x → 99.0",
         _V.REPLAY_DIVERGED, _num01_track1_attacker_pos_x),
        ("NUM-02", "truth_track[1] attacker position.y → 99.0",
         _V.REPLAY_DIVERGED, _num02_track1_attacker_pos_y),
        ("NUM-03", "truth_track[1] attacker velocity.x → 99.0",
         _V.REPLAY_DIVERGED, _num03_track1_attacker_vel_x),
        ("NUM-04", "truth_track[1] attacker velocity.y → 99.0",
         _V.REPLAY_DIVERGED, _num04_track1_attacker_vel_y),
        ("NUM-05", "truth_track[1] defender position.x → 99.0",
         _V.REPLAY_DIVERGED, _num05_track1_defender_pos_x),
        ("NUM-06", "truth_track[1] defender position.y → 99.0",
         _V.REPLAY_DIVERGED, _num06_track1_defender_pos_y),
        ("NUM-07", "truth_track[2] attacker position.x → 99.0 (delayed divergence)",
         _V.REPLAY_DIVERGED, _num07_track2_attacker_pos_x),
        ("NUM-08", "truth_track[1] ball position.x → 99.0",
         _V.REPLAY_DIVERGED, _num08_track1_ball_pos_x),
        ("NUM-09", "truth_track[1] ball position.y → 99.0",
         _V.REPLAY_DIVERGED, _num09_track1_ball_pos_y),
        ("NUM-10", "truth_track[0] attacker position.x → 99.0 (frame-0 divergence from seed)",
         _V.REPLAY_DIVERGED, _num10_track0_attacker_pos_x),
    ]
    return [
        _run_mutation(mid, "NUMERICAL", desc, exp, pristine_dir, campaign_dir, ev, fn)
        for mid, desc, exp, fn in specs
    ]


# ---------------------------------------------------------------------------
# SEMANTIC mutations (belief-state values, truth_track rehashed)
# ---------------------------------------------------------------------------


def _sem01_track1_threat_max(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["belief"]["threat_level"] = "0.999999"
    _write_track(d, track)


def _sem02_track1_intercept_x(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["belief"]["predicted_intercept"]["x"] = "99.000000"
    _write_track(d, track)


def _sem03_track1_intercept_y(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["belief"]["predicted_intercept"]["y"] = "99.000000"
    _write_track(d, track)


def _sem04_track2_threat_min(d: Path) -> None:
    track = _read_track(d)
    track[2]["defender"]["belief"]["threat_level"] = "0.000001"
    _write_track(d, track)


def _sem05_track1_threat_min(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["belief"]["threat_level"] = "0.000001"
    _write_track(d, track)


def _sem06_track2_intercept_x(d: Path) -> None:
    track = _read_track(d)
    track[2]["defender"]["belief"]["predicted_intercept"]["x"] = "99.000000"
    _write_track(d, track)


def _sem07_track1_threat_unit(d: Path) -> None:
    track = _read_track(d)
    track[1]["defender"]["belief"]["threat_level"] = "1.000000"
    _write_track(d, track)


def _sem08_track2_threat_unit(d: Path) -> None:
    track = _read_track(d)
    track[2]["defender"]["belief"]["threat_level"] = "1.000000"
    _write_track(d, track)


def _sem09_track1_threat_near_original(d: Path) -> None:
    # Minimal perturbation: tests precision sensitivity of the threat channel.
    # Actual frame-1 threat is 0.340660; 0.500001 is clearly distinct.
    track = _read_track(d)
    track[1]["defender"]["belief"]["threat_level"] = "0.500001"
    _write_track(d, track)


def _sem10_track4_intercept_x(d: Path) -> None:
    track = _read_track(d)
    track[4]["defender"]["belief"]["predicted_intercept"]["x"] = "99.000000"
    _write_track(d, track)


def _run_semantic_mutations(
    pristine_dir: Path, campaign_dir: Path, ev: str
) -> list[MutationResult]:
    specs = [
        ("SEM-01", "truth_track[1] defender threat_level → 0.999999",
         _V.REPLAY_DIVERGED, _sem01_track1_threat_max),
        ("SEM-02", "truth_track[1] defender predicted_intercept.x → 99.0",
         _V.REPLAY_DIVERGED, _sem02_track1_intercept_x),
        ("SEM-03", "truth_track[1] defender predicted_intercept.y → 99.0",
         _V.REPLAY_DIVERGED, _sem03_track1_intercept_y),
        ("SEM-04", "truth_track[2] defender threat_level → 0.000001 (delayed semantic drift)",
         _V.REPLAY_DIVERGED, _sem04_track2_threat_min),
        ("SEM-05", "truth_track[1] defender threat_level → 0.000001",
         _V.REPLAY_DIVERGED, _sem05_track1_threat_min),
        ("SEM-06", "truth_track[2] defender predicted_intercept.x → 99.0",
         _V.REPLAY_DIVERGED, _sem06_track2_intercept_x),
        ("SEM-07", "truth_track[1] defender threat_level → 1.0 (saturated belief)",
         _V.REPLAY_DIVERGED, _sem07_track1_threat_unit),
        ("SEM-08", "truth_track[2] defender threat_level → 1.0",
         _V.REPLAY_DIVERGED, _sem08_track2_threat_unit),
        ("SEM-09", "truth_track[1] defender threat_level → 0.500001 (precision sensitivity)",
         _V.REPLAY_DIVERGED, _sem09_track1_threat_near_original),
        ("SEM-10", "truth_track[4] defender predicted_intercept.x → 99.0 (late-frame drift)",
         _V.REPLAY_DIVERGED, _sem10_track4_intercept_x),
    ]
    return [
        _run_mutation(mid, "SEMANTIC", desc, exp, pristine_dir, campaign_dir, ev, fn)
        for mid, desc, exp, fn in specs
    ]


# ---------------------------------------------------------------------------
# ENVIRONMENT mutations (version / metadata / governance)
# ---------------------------------------------------------------------------


def _env01_version_999(d: Path) -> None:
    m = _read_manifest(d)
    m["engine_version"] = "9.9.9"
    _write_manifest(d, m)


def _env02_version_empty(d: Path) -> None:
    m = _read_manifest(d)
    m["engine_version"] = ""
    _write_manifest(d, m)


def _env03_version_evil(d: Path) -> None:
    m = _read_manifest(d)
    m["engine_version"] = "evil-version"
    _write_manifest(d, m)


def _env04_delete_version_key(d: Path) -> None:
    m = _read_manifest(d)
    del m["engine_version"]
    _write_manifest(d, m)


def _env05_corrupt_manifest_json(d: Path) -> None:
    (d / "manifest.json").write_text("{not valid json", encoding="utf-8")


def _env06_version_200(d: Path) -> None:
    m = _read_manifest(d)
    m["engine_version"] = "2.0.0"
    _write_manifest(d, m)


def _env07_delete_seed_hash(d: Path) -> None:
    m = _read_manifest(d)
    del m["seed_sha256"]
    _write_manifest(d, m)


def _env08_delete_truth_hash(d: Path) -> None:
    m = _read_manifest(d)
    del m["truth_track_sha256"]
    _write_manifest(d, m)


def _env09_minimal_manifest(d: Path) -> None:
    # Only engine_version; both hashes absent → seed check fails first.
    _write_manifest(d, {"engine_version": "1.0.0"})


def _env10_null_version(d: Path) -> None:
    m = _read_manifest(d)
    m["engine_version"] = None  # JSON null → Python None → mismatch
    _write_manifest(d, m)


def _run_environment_mutations(
    pristine_dir: Path, campaign_dir: Path, ev: str
) -> list[MutationResult]:
    specs = [
        ("ENV-01", "manifest engine_version → '9.9.9'",
         _V.ENGINE_VERSION_FAILURE, _env01_version_999),
        ("ENV-02", "manifest engine_version → '' (empty string)",
         _V.ENGINE_VERSION_FAILURE, _env02_version_empty),
        ("ENV-03", "manifest engine_version → 'evil-version'",
         _V.ENGINE_VERSION_FAILURE, _env03_version_evil),
        ("ENV-04", "Delete engine_version key from manifest",
         _V.ENGINE_VERSION_FAILURE, _env04_delete_version_key),
        ("ENV-05", "Write invalid JSON to manifest.json",
         _V.INVALID_ARTIFACT, _env05_corrupt_manifest_json),
        ("ENV-06", "manifest engine_version → '2.0.0'",
         _V.ENGINE_VERSION_FAILURE, _env06_version_200),
        ("ENV-07", "Delete seed_sha256 from manifest",
         _V.SEED_MISMATCH, _env07_delete_seed_hash),
        ("ENV-08", "Delete truth_track_sha256 from manifest",
         _V.HASH_FAILURE, _env08_delete_truth_hash),
        ("ENV-09", "Replace manifest with minimal version-only dict (both hashes absent)",
         _V.SEED_MISMATCH, _env09_minimal_manifest),
        ("ENV-10", "manifest engine_version → null (JSON null self-cert attack)",
         _V.ENGINE_VERSION_FAILURE, _env10_null_version),
    ]
    return [
        _run_mutation(mid, "ENVIRONMENT", desc, exp, pristine_dir, campaign_dir, ev, fn)
        for mid, desc, exp, fn in specs
    ]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def run_mutation_campaign(
    pristine_dir: Path,
    campaign_dir: Path,
    engine_version: str,
    timestamp: str,
) -> CampaignReport:
    """Run 50 controlled mutations and return a calibration report.

    Parameters
    ----------
    pristine_dir:
        A verified replay bundle directory (seed_snapshot.json,
        truth_track.json, manifest.json).  Must have at least 5 frames
        so all temporal mutations have valid frame indices to target.
    campaign_dir:
        Root directory for mutation scratch directories.  Created if absent.
        Each mutation writes to campaign_dir/<mutation_id>/.
    engine_version:
        The version string the verifier expects.
    timestamp:
        ISO-8601 timestamp identifying this campaign run.
    """
    campaign_dir.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(
        (pristine_dir / "truth_track.json").read_bytes()
    ).hexdigest()

    results: list[MutationResult] = []
    results.extend(_run_integrity_mutations(pristine_dir, campaign_dir, engine_version))
    results.extend(_run_temporal_mutations(pristine_dir, campaign_dir, engine_version))
    results.extend(_run_numerical_mutations(pristine_dir, campaign_dir, engine_version))
    results.extend(_run_semantic_mutations(pristine_dir, campaign_dir, engine_version))
    results.extend(_run_environment_mutations(pristine_dir, campaign_dir, engine_version))

    n = len(results)
    detected = sum(1 for r in results if r.detected)
    correct = sum(1 for r in results if r.correct_code)

    return CampaignReport(
        campaign_id=f"mutation-campaign-{timestamp}",
        source_bundle_hash=source_hash,
        engine_version=engine_version,
        timestamp=timestamp,
        mutation_count=n,
        detected_count=detected,
        correct_code_count=correct,
        detection_rate=detected / n if n > 0 else 0.0,
        classification_accuracy=correct / n if n > 0 else 0.0,
        results=results,
    )


def write_campaign_archive(report: CampaignReport, archive_dir: Path) -> None:
    """Persist a CampaignReport as three JSON files in archive_dir.

    Files written
    -------------
    campaign_metadata.json  : scalar summary fields
    results.json            : per-mutation records (ordered by mutation_id)
    diagnostics.json        : per-taxonomy-class aggregates
    """
    archive_dir.mkdir(parents=True, exist_ok=True)

    metadata: dict = {
        "campaign_id": report.campaign_id,
        "source_bundle_hash": report.source_bundle_hash,
        "engine_version": report.engine_version,
        "timestamp": report.timestamp,
        "mutation_count": report.mutation_count,
        "detected_count": report.detected_count,
        "correct_code_count": report.correct_code_count,
        "detection_rate": report.detection_rate,
        "classification_accuracy": report.classification_accuracy,
    }
    (archive_dir / "campaign_metadata.json").write_text(
        json.dumps(metadata, sort_keys=True, indent=2), encoding="utf-8"
    )

    results_list = [
        {
            "mutation_id": r.mutation_id,
            "taxonomy_class": r.taxonomy_class,
            "description": r.description,
            "expected_result": r.expected_result.name,
            "observed_result": r.observed_result.name,
            "detected": r.detected,
            "correct_code": r.correct_code,
            "execution_ms": r.execution_ms,
        }
        for r in report.results
    ]
    (archive_dir / "results.json").write_text(
        json.dumps(results_list, sort_keys=True, indent=2), encoding="utf-8"
    )

    taxonomy_classes = ("INTEGRITY", "TEMPORAL", "NUMERICAL", "SEMANTIC", "ENVIRONMENT")
    diagnostics: dict = {}
    for tc in taxonomy_classes:
        tc_results = [r for r in report.results if r.taxonomy_class == tc]
        if not tc_results:
            continue
        n = len(tc_results)
        det = sum(1 for r in tc_results if r.detected)
        cor = sum(1 for r in tc_results if r.correct_code)
        diagnostics[tc] = {
            "count": n,
            "detected": det,
            "correct_code": cor,
            "detection_rate": det / n,
            "classification_accuracy": cor / n,
        }
    (archive_dir / "diagnostics.json").write_text(
        json.dumps(diagnostics, sort_keys=True, indent=2), encoding="utf-8"
    )

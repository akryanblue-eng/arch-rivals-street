import subprocess

import pytest

from engine.recovery_probe import (
    fresh_clone_at_commit,
    run,
    run_probe,
    unity_structure_ok,
)


@pytest.fixture
def local_repo_url(tmp_path):
    """A throwaway local git repo standing in for the real remote, since
    cloning over the network in a test isn't reproducible. fresh_clone_at_commit
    only cares that `git clone` accepts the URL/path string as-is.
    """
    repo_dir = tmp_path / "origin"
    repo_dir.mkdir()
    subprocess.run(["git", "init", "-q", str(repo_dir)], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.email", "test@test.com"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.name", "test"], check=True)
    (repo_dir / "README.md").write_text("hello\n")
    subprocess.run(["git", "-C", str(repo_dir), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "commit", "-q", "-m", "init"], check=True)
    head = subprocess.run(
        ["git", "-C", str(repo_dir), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    return str(repo_dir), head


def test_run_uses_no_shell_and_returns_tuple():
    ok, output, code = run(["echo", "hello"])
    assert ok is True
    assert "hello" in output
    assert code == 0


def test_fresh_clone_at_commit_records_exact_head_sha(local_repo_url, tmp_path):
    repo_path, head = local_repo_url
    dest = tmp_path / "clone"
    ok, log, head_sha = fresh_clone_at_commit(repo_path, head, str(dest))
    assert ok is True
    assert head_sha == head


def test_fresh_clone_at_commit_fails_on_bad_commit(local_repo_url, tmp_path):
    repo_path, _ = local_repo_url
    dest = tmp_path / "clone"
    ok, log, head_sha = fresh_clone_at_commit(repo_path, "0000000000000000000000000000000000000000", str(dest))
    assert ok is False
    assert head_sha is None


def test_unity_structure_ok_false_for_readme_only_repo(local_repo_url, tmp_path):
    repo_path, head = local_repo_url
    dest = tmp_path / "clone"
    fresh_clone_at_commit(repo_path, head, str(dest))
    assert unity_structure_ok(str(dest)) is False


def test_run_probe_against_readme_only_repo_observes_missing_structure(local_repo_url):
    repo_path, head = local_repo_url
    report = run_probe(repo_path, head)
    assert report.observations["unity_structure_ok"] is False
    assert report.evidence.git_head_sha == head
    assert report.evidence.workdir_is_temp is True


def test_run_probe_against_this_actual_repo_has_placeholder_structure_but_cannot_boot():
    """Ground-truth regression: arch-rivals-street now has a placeholder
    Unity skeleton (Assets/Packages/ProjectSettings exist), but no real
    UNITY_PATH is configured in this environment, so the probe must report
    the structure as present while honestly skipping the boot check rather
    than claiming a verified boot it never performed.
    """
    report = run_probe(".", "HEAD")
    assert report.observations["unity_structure_ok"] is True
    assert report.observations["unity_boot_attempted"] is False
    assert report.observations["unity_boot_ok"] is False

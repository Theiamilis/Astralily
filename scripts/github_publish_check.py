import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

LOCAL_ONLY_PATTERNS = [
    re.compile(r"(^|/)\.tmp-core-pairing(/|$)"),
    re.compile(r"(^|/)\.env($|\.)"),
    re.compile(r"(^|/)node_modules/"),
    re.compile(r"(^|/)dist/"),
    re.compile(r"(^|/)venv/"),
    re.compile(r"(^|/)__pycache__/"),
    re.compile(r"(^|/)\.pytest_cache/"),
    re.compile(r"(^|/)\.mypy_cache/"),
    re.compile(r"(^|/)\.ruff_cache/"),
    re.compile(r"(^|/)\.agents/"),
    re.compile(r"(^|/)\.openclaw/"),
    re.compile(r"(^|/)\.hermes/"),
    re.compile(r"(^|/)LilyAgents/"),
    re.compile(r"(^|/)CubismSdkForWeb-5-r\.5/"),
    re.compile(r"(^|/)tools/GPT-SoVITS/"),
    re.compile(r"(^|/)lily_wa_vessel/\.wwebjs_auth/"),
    re.compile(r"(^|/)lily_wa_vessel/\.wwebjs_cache/"),
    re.compile(r"(^|/)lily_wa_vessel/(contact_profiles|owner_memory|external_inbox)\.json$"),
    re.compile(r"(^|/)public/Framework/"),
    re.compile(r"(^|/)public/live2d/(?!\.gitkeep$).+"),
    re.compile(r"(^|/)local_assets/(voice_models|live2d_models|listener_voice_previews)/(?!README\.md$)"),
    re.compile(r"(^|/)(runtime|credentials)/"),
    re.compile(r"\.(sqlite3?|db|wal|shm)$", re.IGNORECASE),
    re.compile(r"\.(pth|ckpt|safetensors|gguf|onnx|moc3|model3)$", re.IGNORECASE),
    re.compile(r"(^|/)model\.index$", re.IGNORECASE),
    re.compile(r"(^|/)\.cloudflared/"),
    re.compile(r"(^|/)lily_essence_core/static/audio/(?!\.gitkeep$).+"),
    re.compile(r"(^|/)lily_essence_core/static/ref_voice"),
    re.compile(r"(^|/)lily_essence_core/static/ref_voice.*"),
    re.compile(r"(^|/)logs/"),
    re.compile(r"\.(zip|rar|tar\.gz)$"),
]

SECRET_PATTERNS = [
    ("openai_or_compat_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("openai_compat_enx_key", re.compile(r"\benx-[A-Za-z0-9_-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("groq_api_key", re.compile(r"\bgsk_[A-Za-z0-9_-]{20,}\b")),
    ("huggingface_token", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("tailscale_auth_key", re.compile(r"\btskey-(auth|api|client)-[A-Za-z0-9-]{20,}\b")),
    ("jwt_token", re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{10,}\b")),
]

ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*['\"]?([A-Za-z0-9_\-./+=:$%{}<>]{12,})"
)

SAFE_ASSIGNMENT_VALUES = {
    "example",
    "placeholder",
    "fake",
    "dummy",
    "not-needed",
    "changeme",
    "your-token-here",
    "your-api-key",
    "lm-studio",
    "test-session",
    "test%26token",
}


@dataclass(frozen=True)
class Finding:
    kind: str
    path: str
    detail: str
    line: int | None = None


@dataclass(frozen=True)
class PublishReport:
    mode: str
    candidate_count: int
    tracked_count: int
    untracked_count: int
    staged_count: int
    new_source_files: list[str]
    local_only_findings: list[Finding]
    secret_findings: list[Finding]


def _run_git(args: list[str], root: Path = ROOT) -> list[str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "git command failed").strip())
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def normalize_path(path: str | Path) -> str:
    normalized = str(path).replace("\\", "/")
    if normalized.startswith("./"):
        return normalized[2:]
    return normalized


def is_env_example(path: str) -> bool:
    normalized = normalize_path(path)
    return re.search(r"(^|/)\.env(?:\.[^/]+)?\.example$", normalized) is not None


def is_local_only_candidate(path: str) -> bool:
    normalized = normalize_path(path)
    if is_env_example(normalized):
        return False
    return any(pattern.search(normalized) for pattern in LOCAL_ONLY_PATTERNS)


def tracked_files(root: Path = ROOT) -> list[str]:
    return sorted(set(_run_git(["ls-files"], root)))


def untracked_files(root: Path = ROOT) -> list[str]:
    return sorted(set(_run_git(["ls-files", "-o", "--exclude-standard"], root)))


def staged_files(root: Path = ROOT) -> list[str]:
    return sorted(set(_run_git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], root)))


def candidate_files(root: Path = ROOT, staged_only: bool = False) -> tuple[list[str], list[str], list[str], list[str]]:
    tracked = tracked_files(root)
    untracked = untracked_files(root)
    staged = staged_files(root)
    if staged_only:
        return staged, tracked, untracked, staged
    return sorted(set(tracked + untracked)), tracked, untracked, staged


def local_only_findings(paths: list[str]) -> list[Finding]:
    return [
        Finding("local_only_path", normalize_path(path), "local-only path is a Git candidate")
        for path in paths
        if is_local_only_candidate(path)
    ]


def _is_probably_text(path: Path) -> bool:
    try:
        sample = path.read_bytes()[:4096]
    except OSError:
        return False
    return b"\x00" not in sample


def _safe_assignment_value(value: str) -> bool:
    raw = value.strip().strip("'\"")
    if re.fullmatch(r"[A-Z][A-Z0-9_]{3,}", raw):
        return True
    normalized = raw.lower()
    if not normalized:
        return True
    if normalized in SAFE_ASSIGNMENT_VALUES:
        return True
    if normalized.startswith(("your_", "your-", "example_", "fake_", "dummy_", "test-", "test%", "<", "{", "%")):
        return True
    if normalized.startswith(
        ("settings.", "preferences.", "os.", "process.", "self.", "config.", "env.", "secrets.")
    ):
        return True
    if "getenv" in normalized:
        return True
    if set(normalized) <= {"x", ":", "-", "_"}:
        return True
    return False


def scan_file_for_secrets(root: Path, relative_path: str) -> list[Finding]:
    path = root / relative_path
    if not path.exists() or not path.is_file() or not _is_probably_text(path):
        return []

    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []

    findings: list[Finding] = []
    normalized = normalize_path(relative_path)
    for line_number, line in enumerate(lines, start=1):
        for name, pattern in SECRET_PATTERNS:
            if pattern.search(line):
                findings.append(Finding("secret_pattern", normalized, name, line_number))

        for match in ASSIGNMENT_PATTERN.finditer(line):
            value = match.group(2)
            code_suffixes = {".py", ".js", ".jsx", ".ts", ".tsx", ".rs", ".kt", ".java"}
            if path.suffix.lower() in code_suffixes and line[match.start(2) - 1] not in {"'", '"'}:
                continue
            if not _safe_assignment_value(value):
                findings.append(Finding("secret_assignment", normalized, match.group(1).lower(), line_number))

    return findings


def scan_for_secrets(root: Path, paths: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    for path in paths:
        if is_local_only_candidate(path):
            continue
        findings.extend(scan_file_for_secrets(root, path))
    return findings


def build_report(root: Path = ROOT, staged_only: bool = False) -> PublishReport:
    candidates, tracked, untracked, staged = candidate_files(root, staged_only)
    local_findings = local_only_findings(candidates)
    secret_findings = scan_for_secrets(root, candidates)
    return PublishReport(
        mode="staged" if staged_only else "all-candidates",
        candidate_count=len(candidates),
        tracked_count=len(tracked),
        untracked_count=len(untracked),
        staged_count=len(staged),
        new_source_files=[] if staged_only else untracked,
        local_only_findings=local_findings,
        secret_findings=secret_findings,
    )


def report_failed(report: PublishReport) -> bool:
    return bool(report.local_only_findings or report.secret_findings)


def results_to_payload(report: PublishReport) -> dict[str, Any]:
    return {
        "status": "failed" if report_failed(report) else "ok",
        **asdict(report),
    }


def print_human(report: PublishReport) -> None:
    print(f"Lily GitHub publish preflight ({report.mode})")
    print(
        "Candidates: "
        f"{report.candidate_count} scanned, "
        f"{report.tracked_count} tracked, "
        f"{report.untracked_count} untracked, "
        f"{report.staged_count} staged"
    )

    if report.local_only_findings:
        print("[FAIL] local-only path guard")
        for finding in report.local_only_findings:
            print(f"       {finding.path} - {finding.detail}")
    else:
        print("[PASS] local-only path guard")

    if report.secret_findings:
        print("[FAIL] secret pattern scan")
        for finding in report.secret_findings:
            suffix = f":{finding.line}" if finding.line else ""
            print(f"       {finding.path}{suffix} - {finding.detail}")
    else:
        print("[PASS] secret pattern scan")

    if report.new_source_files:
        print("New source candidates:")
        for path in report.new_source_files:
            print(f"       {path}")

    failures = len(report.local_only_findings) + len(report.secret_findings)
    print(f"Summary: {failures} finding(s)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Preflight checks before publishing Lily to a private GitHub repo.")
    parser.add_argument("--staged", action="store_true", help="Scan staged files only instead of all Git candidates.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON without secret values.")
    args = parser.parse_args(argv)

    try:
        report = build_report(ROOT, staged_only=args.staged)
    except RuntimeError as error:
        print(f"Publish check failed: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(results_to_payload(report), indent=2))
    else:
        print_human(report)

    return 1 if report_failed(report) else 0


if __name__ == "__main__":
    raise SystemExit(main())

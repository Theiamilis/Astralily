import importlib.util
import json
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PUBLISH_CHECK_PY = ROOT / "scripts" / "github_publish_check.py"


def _load_publish_check_module():
    spec = importlib.util.spec_from_file_location("github_publish_check_contract", PUBLISH_CHECK_PY)
    if not spec or not spec.loader:
        raise RuntimeError("Could not load scripts/github_publish_check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> None:
    publish_check = _load_publish_check_module()

    assert publish_check.is_local_only_candidate(".env") is True
    assert publish_check.is_local_only_candidate("lily_essence_core/.env") is True
    assert publish_check.is_local_only_candidate("lily_essence_core/.env.example") is False
    assert publish_check.is_local_only_candidate("lily_wa_vessel/.env.public.example") is False
    assert publish_check.is_local_only_candidate("lily_wa_vessel/.env.public") is True
    assert publish_check.is_local_only_candidate("lily_stream_stage/public/live2d/.gitkeep") is False
    assert publish_check.is_local_only_candidate("lily_stream_stage/public/live2d/model/model3.json") is True
    assert publish_check.is_local_only_candidate("tools/GPT-SoVITS/api.py") is True
    assert publish_check.is_local_only_candidate("lily_wa_vessel/.wwebjs_auth/session.json") is True

    with tempfile.TemporaryDirectory() as temp_root:
        root = Path(temp_root)
        fake_secret = "sk-" + "1234567890abcdefghijklmnop"
        fake_password = "super-" + "secret-" + "value"
        _write(
            root / "safe.py",
            "TOKEN=\nAPI_KEY=example\nOPENAI_API_KEY = os.getenv('OPENAI_API_KEY', '')\n"
            "generated = secrets.token_urlsafe(32)\n"
            "url = 'http://127.0.0.1:5233/?token=test%26token'\n"
            "session = '/?token=test-session'\n",
        )
        _write(root / "leaky.py", f"key = '{fake_secret}'\n")
        _write(root / "secret.env.example", "API_KEY=\n")
        _write(root / "config.txt", f"password={fake_password}\n")
        _write(root / "script.sh", f"TOKEN={fake_password}\n")
        _write(root / "runtime.py", "token = existing_secret_variable\n")

        safe_findings = publish_check.scan_file_for_secrets(root, "safe.py")
        assert safe_findings == []

        leaky_findings = publish_check.scan_file_for_secrets(root, "leaky.py")
        assert len(leaky_findings) == 1
        assert leaky_findings[0].detail == "openai_or_compat_key"
        assert leaky_findings[0].line == 1

        assignment_findings = publish_check.scan_file_for_secrets(root, "config.txt")
        assert len(assignment_findings) == 1
        assert assignment_findings[0].kind == "secret_assignment"
        assert len(publish_check.scan_file_for_secrets(root, "script.sh")) == 1
        assert publish_check.scan_file_for_secrets(root, "runtime.py") == []

        report = publish_check.PublishReport(
            mode="contract",
            candidate_count=2,
            tracked_count=1,
            untracked_count=1,
            staged_count=0,
            new_source_files=["leaky.py"],
            local_only_findings=[],
            secret_findings=leaky_findings,
        )
        payload = publish_check.results_to_payload(report)
        encoded = json.dumps(payload)
        assert payload["status"] == "failed"
        assert fake_secret not in encoded
        assert "leaky.py" in encoded

    print("github publish check contract smoke tests passed")


if __name__ == "__main__":
    main()

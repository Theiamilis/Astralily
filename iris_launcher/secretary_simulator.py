"""Local secretary experiment. No bridge, delivery, or settings writes."""
import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lily_essence_core'))


def simulate(payload):
    from lily_core.secretary_settings import SecretarySettings, ContactRule
    from lily_core.wa_secretary import SecretaryRequest, generate_secretary_reply, requests_silence, is_closing_thanks

    config = SecretarySettings.model_validate(payload['settings'])
    number = ContactRule.normalize_number(str(payload.get('number', '08000000001')))
    rule = next((r for r in config.contacts if r.number == number), None)
    action = rule.action if rule else config.default_action
    request = SecretaryRequest.model_validate(payload['request'])
    if request.owner_name.strip().casefold() in {'', 'owner', 'pemilik'}:
        request.owner_name = 'Lily User'
    if rule and rule.label:
        request.contact_name = rule.label
    reason = None
    if action == 'ignore':
        reason = 'Ignored by contact rule. No reply or summary.'
    elif action == 'summary_only':
        reason = 'Summary only: captured for owner review; no reply.'
    elif payload.get('takeover') is True:
        reason = 'Owner took over. Automatic replies are paused in this simulation.'
    elif config.mode == 'off' or (config.mode == 'auto' and not request.owner_busy):
        reason = 'Secretary is inactive for the simulated presence.'
    elif int(payload.get('turns', 0)) >= config.max_replies:
        reason = 'Reply limit reached. Owner decision required.'
    if reason:
        return {'action': action, 'reason': reason, 'reply': '',
                'summary': request.message if action == 'summary_only' else '',
                'needs_owner': action != 'ignore', 'used_model': False}
    result = generate_secretary_reply(request, config.system_prompt).model_dump()
    return {**result, 'action': action, 'reason': 'Secretary would reply.' if result['reply'] else 'No reply requested; nothing would be sent.', 'used_model': not (requests_silence(request.message) or is_closing_thanks(request.message))}


if __name__ == '__main__':
    try:
        with tempfile.TemporaryDirectory(prefix='iris-secretary-preview-') as runtime:
            os.environ['LILY_STATE_DB_PATH'] = str(Path(runtime) / 'state.sqlite3')
            with contextlib.redirect_stdout(sys.stderr):
                result = simulate(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=True))
    except Exception:
        print(json.dumps({'error': 'Simulation failed. Check local Core dependencies, LLM configuration, and input.'}))
        sys.exit(1)

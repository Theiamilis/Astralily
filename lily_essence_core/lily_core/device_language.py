"""Deterministic operational replies; never translate execution or confirmation IDs."""


def device_language(value: object) -> str:
    language = str(value or "").strip().lower().replace("_", "-")
    if language.startswith("ja") or language in {"japanese", "日本語"}:
        return "ja"
    if language.startswith("en") or language == "english":
        return "en"
    return "id"


# Entries are Indonesian, English, Japanese, in that order.
REPLIES = {
    "clarify": ("Perangkat yang mana yang kamu maksud?", "Which device do you mean?", "どの機器のことですか？"),
    "no_action": ("Oke, aku nggak mengubah perangkatnya.", "Okay, I won't change any devices.", "わかりました。機器の操作はしません。"),
    "interpret_error": ("Aku belum berhasil memahami pesannya. Coba ulang sebentar ya.", "I couldn't interpret that reliably. Please try again.", "指示を正確に理解できませんでした。もう一度お願いします。"),
    "wake": ("Udah Lily kirim sinyal buat nyalain PC. Tunggu bentar ya, biasanya butuh beberapa detik buat bangun.", "I've sent the PC a wake signal. It may take a few seconds to start.", "PCに起動信号を送りました。起動まで少し待ってください。"),
    "wake_error": ("Lily belum bisa nyalain PC dari sini. {detail}", "I couldn't send the PC wake signal. Please check its connection and wake configuration.", "PCに起動信号を送れませんでした。接続と起動設定を確認してください。"),
    "home_error": ("{detail}", "I couldn't complete the light request. Check the device connection or specify the target and setting again.", "照明の操作を完了できませんでした。機器の接続を確認するか、対象と設定をもう一度指定してください。"),
    "power_help": ("Power commands: `/power status <target>`, `/power history [target]`, `/power shutdown <target>`, `/power restart <target>`, `/power hibernate <target>`, atau `/power abort <target>`. Target aksi wajib ditulis.", "Use `/power status <target>`, `/power history [target]`, `/power shutdown <target>`, `/power restart <target>`, `/power hibernate <target>`, or `/power abort <target>`. Specify the target for actions.", "対象を指定してください：`/power status <target>`、`/power history [target]`、`/power shutdown <target>`、`/power restart <target>`、`/power hibernate <target>`、`/power abort <target>`。"),
    "unknown_target": ("Target `{target}` nggak terdaftar. Sebut nama perangkat yang terdaftar.", "Target `{target}` is not registered. Specify a registered device.", "`{target}` は登録されていません。登録済みの機器を指定してください。"),
    "no_pending": ("Nggak ada permintaan power yang sedang menunggu konfirmasi.", "No power request is waiting for confirmation.", "確認待ちの電源操作はありません。"),
    "invalid_confirmation": ("Kode konfirmasinya tidak cocok. Pakai persis kode dari permintaan power terakhir.", "The confirmation code does not match. Use the exact code from the latest power request.", "確認コードが一致しません。直前の電源操作に表示されたコードをそのまま使ってください。"),
    "pending": ("Lily siap {action} {target}. Konfirmasi dalam 60 detik dengan `/power confirm {code}`.", "Ready to {action} {target}. Confirm within 60 seconds with `/power confirm {code}`.", "{target} の{action}を準備しました。60秒以内に `/power confirm {code}` で確認してください。"),
    "denied": ("Oke, permintaan {action} untuk {target} dibatalkan. Nggak ada yang dijalankan.", "Cancelled the {action} request for {target}. Nothing was executed.", "{target} の{action}を取り消しました。操作は実行していません。"),
    "unavailable": ("{target} sudah terdaftar, tapi akses remote power-nya belum aktif.", "{target} is registered, but remote power control is not enabled.", "{target} は登録済みですが、リモート電源操作は有効になっていません。"),
    "status_error": ("Lily belum bisa memeriksa {target}. {detail}", "I couldn't check {target}. Please check its connection.", "{target} の状態を確認できませんでした。接続を確認してください。"),
    "offline": ("{target} sedang offline atau tidak bisa dijangkau lewat Tailscale.", "{target} is offline or unreachable over Tailscale.", "{target} はオフラインか、Tailscale経由で接続できません。"),
    "status": ("{target} online. Uptime {hours}h {minutes}m, CPU {cpu}%, RAM {used:.1f}/{total:.1f} GB, user `{user}`.", "{target} is online. Uptime {hours}h {minutes}m, CPU {cpu}%, RAM {used:.1f}/{total:.1f} GB, user `{user}`.", "{target} はオンラインです。稼働時間 {hours}時間{minutes}分、CPU {cpu}%、メモリ {used:.1f}/{total:.1f} GB、ユーザー `{user}`。"),
    "history_error": ("Lily belum bisa membaca power history. {detail}", "I couldn't read the power history.", "電源操作の履歴を取得できませんでした。"),
    "history_empty": ("Belum ada power history untuk {target}.", "No power history for {target} yet.", "{target} の電源操作の履歴はまだありません。"),
    "history": ("Riwayat power:", "Power history:", "電源操作の履歴："),
    "power_error": ("Lily gagal menjalankan {action} di {target}. {detail}", "The {action} request for {target} failed. Check its connection and configuration.", "{target} の{action}に失敗しました。接続と設定を確認してください。"),
    "power_delayed": ("Oke, {target} menerima perintah {action}. Ada jeda 60 detik kalau kamu perlu membatalkannya.", "{target} accepted the {action} command. You have 60 seconds to cancel it.", "{target} が{action}の指示を受け付けました。取り消す場合は60秒以内に操作してください。"),
    "hibernate": ("Oke, {target} sedang masuk hibernate.", "{target} is entering hibernation.", "{target} は休止状態に入ります。"),
    "abort": ("Sip, jadwal shutdown di {target} sudah dibatalkan.", "The scheduled shutdown on {target} was cancelled.", "{target} のシャットダウン予約を取り消しました。"),
}


def device_text(language: object, key: str, **values: object) -> str:
    index = {"id": 0, "en": 1, "ja": 2}[device_language(language)]
    return REPLIES[key][index].format(**values)


def power_action_label(action: str, language: object) -> str:
    labels = {
        "shutdown": ("matikan", "shut down", "シャットダウン"),
        "restart": ("restart", "restart", "再起動"),
        "hibernate": ("hibernate-kan", "hibernate", "休止"),
        "cancel": ("batalkan shutdown di", "cancel shutdown on", "シャットダウン予約の取り消し"),
    }
    return labels.get(action, (action, action, action))[{"id": 0, "en": 1, "ja": 2}[device_language(language)]]

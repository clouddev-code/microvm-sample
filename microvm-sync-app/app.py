import http.server
import logging
import os
import threading

from flask import Flask, jsonify

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync-app")

# ビルド/ライフサイクルフックは、アプリ本体とは別のポートで待ち受ける
# （microvm-workerと同じ構成。フック用ポート共用が/readyタイムアウトの原因になった実機教訓による）。
HOOKS_PORT = int(os.environ.get("HOOKS_PORT", "9000"))
APP_PORT = int(os.environ.get("APP_PORT", "8080"))

flask_app = Flask(__name__)


@flask_app.get("/")
def hello_world():
    return jsonify(message="Hello, World!")


_app_started = False
_app_lock = threading.Lock()


def ensure_app_started() -> None:
    global _app_started
    with _app_lock:
        if not _app_started:
            threading.Thread(
                target=flask_app.run,
                kwargs={"host": "0.0.0.0", "port": APP_PORT, "threaded": True, "use_reloader": False},
                daemon=True,
            ).start()
            _app_started = True
            log.info("flask app started on port %d", APP_PORT)


class HooksHandler(http.server.BaseHTTPRequestHandler):
    def _respond(self, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        if self.path.endswith("/ready"):
            self._respond(200)
        else:
            self._respond(404)

    def do_POST(self):
        self._read_body()
        if self.path.endswith("/ready"):
            self._respond(200)
        elif self.path.endswith("/validate"):
            self._respond(200)
        elif self.path.endswith("/run"):
            log.info("hook: /run")
            ensure_app_started()
            self._respond(200)
        elif self.path.endswith("/resume"):
            log.info("hook: /resume")
            ensure_app_started()
            self._respond(200)
        elif self.path.endswith("/suspend"):
            log.info("hook: /suspend")
            self._respond(200)
        elif self.path.endswith("/terminate"):
            log.info("hook: /terminate")
            self._respond(200)
        else:
            self._respond(404)

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)


if __name__ == "__main__":
    # Flaskアプリ本体は起動時ではなく、/run・/resumeフックで初めて起動する
    # （フックのタイミングとアプリ起動を揃えるmicrovm-workerと同じ流儀）。
    server = http.server.ThreadingHTTPServer(("0.0.0.0", HOOKS_PORT), HooksHandler)
    log.info("hooks listening on port %d", HOOKS_PORT)
    server.serve_forever()

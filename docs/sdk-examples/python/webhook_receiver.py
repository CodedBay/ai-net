"""Minimal HMAC-verifying receiver for an application webhook adapter."""

import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        supplied = self.headers.get("X-Ainet-Signature", "")
        expected = "sha256=" + hmac.new(
            os.environ["WEBHOOK_SECRET"].encode(), body, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            self.send_error(401, "Invalid webhook signature")
            return

        event = json.loads(body)
        print(json.dumps(event, indent=2))
        self.send_response(204)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    print(f"Listening for signed callbacks on http://127.0.0.1:{port}/")
    HTTPServer(("127.0.0.1", port), WebhookHandler).serve_forever()
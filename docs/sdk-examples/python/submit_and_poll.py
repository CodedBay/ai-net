"""Submit a task and poll its status using the v2 API."""

import os
import sys
import time

import requests


API_URL = os.getenv("AINET_API_URL", "http://localhost:3000").rstrip("/")
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
POLL_TIMEOUT = float(os.getenv("POLL_TIMEOUT_SECONDS", "300"))
TERMINAL_STATES = {"completed", "failed", "cancelled"}


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python submit_and_poll.py "task prompt"')

    wallet = os.environ["STELLAR_PUBLIC_KEY"]
    headers = {"API-Version": "2.0", "WalletPublicKey": wallet}
    submitted = requests.post(
        f"{API_URL}/api/tasks",
        headers=headers,
        json={"prompt": " ".join(sys.argv[1:]), "walletPublicKey": wallet},
        timeout=20,
    )
    submitted.raise_for_status()
    task_id = submitted.json()["data"]["taskId"]
    print(f"Submitted {task_id}")

    deadline = time.monotonic() + POLL_TIMEOUT
    while time.monotonic() < deadline:
        result = requests.get(
            f"{API_URL}/api/tasks/{task_id}", headers=headers, timeout=20
        )
        result.raise_for_status()
        task = result.json()["data"]
        print(f"{task_id}: {task['status']}")
        if task["status"] in TERMINAL_STATES:
            print(task)
            return
        time.sleep(POLL_INTERVAL)

    raise TimeoutError(f"Task {task_id} did not finish within {POLL_TIMEOUT}s")


if __name__ == "__main__":
    main()
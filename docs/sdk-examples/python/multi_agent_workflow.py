"""Fan out specialist tasks to ai-net and collect their results."""

import os
import sys
import time

import requests


API_URL = os.getenv("AINET_API_URL", "http://localhost:3000").rstrip("/")
SPECIALISTS = ("research", "security", "editor")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python multi_agent_workflow.py "topic"')

    wallet = os.environ["STELLAR_PUBLIC_KEY"]
    headers = {"API-Version": "2.0", "WalletPublicKey": wallet}
    topic = " ".join(sys.argv[1:])
    task_ids = []
    for specialist in SPECIALISTS:
        response = requests.post(
            f"{API_URL}/api/tasks",
            headers=headers,
            json={
                "prompt": f"As the {specialist} specialist, work on: {topic}",
                "walletPublicKey": wallet,
                "agentPreferences": [specialist],
            },
            timeout=20,
        )
        response.raise_for_status()
        task_ids.append(response.json()["data"]["taskId"])

    remaining = set(task_ids)
    deadline = time.monotonic() + float(os.getenv("POLL_TIMEOUT_SECONDS", "300"))
    while remaining and time.monotonic() < deadline:
        for task_id in tuple(remaining):
            response = requests.get(
                f"{API_URL}/api/tasks/{task_id}", headers=headers, timeout=20
            )
            response.raise_for_status()
            task = response.json()["data"]
            if task["status"] in {"completed", "failed", "cancelled"}:
                print(f"{task_id}: {task['status']}\n{task}")
                remaining.remove(task_id)
        if remaining:
            time.sleep(float(os.getenv("POLL_INTERVAL_SECONDS", "2")))

    if remaining:
        raise TimeoutError(f"Tasks did not finish: {', '.join(sorted(remaining))}")


if __name__ == "__main__":
    main()
"""Expose ai-net task submission as a LangChain tool."""

import os
import sys

import requests
from langchain_core.tools import tool


API_URL = os.getenv("AINET_API_URL", "http://localhost:3000").rstrip("/")


@tool
def submit_ainet_task(prompt: str) -> str:
    """Submit a prompt to ai-net and return its task ID."""
    wallet = os.environ["STELLAR_PUBLIC_KEY"]
    response = requests.post(
        f"{API_URL}/api/tasks",
        headers={"API-Version": "2.0", "WalletPublicKey": wallet},
        json={"prompt": prompt, "walletPublicKey": wallet},
        timeout=20,
    )
    response.raise_for_status()
    return response.json()["data"]["taskId"]


if __name__ == "__main__":
    prompt = " ".join(sys.argv[1:]) or "Summarize the Stellar ecosystem"
    print(submit_ainet_task.invoke({"prompt": prompt}))
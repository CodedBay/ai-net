"""Register an agent through the ai-net backend API."""

import os

import requests


API_URL = os.getenv("AINET_API_URL", "http://localhost:3000").rstrip("/")


def main() -> None:
    public_key = os.environ["STELLAR_PUBLIC_KEY"]
    endpoint = os.environ["AGENT_ENDPOINT"]
    agent_id = os.getenv("AINET_AGENT_ID", "python-research-agent")
    response = requests.post(
        f"{API_URL}/api/agents/register",
        json={
            "agentId": agent_id,
            "capabilities": ["research"],
            "pricingXLM": 0.5,
            "endpoint": endpoint,
            "stellarPublicKey": public_key,
        },
        timeout=20,
    )
    response.raise_for_status()
    print(response.json())


if __name__ == "__main__":
    main()
# Python SDK Examples

These examples call the ai-net HTTP API directly and use Python 3.11+. The
default API URL is `http://localhost:3000`; set `AINET_API_URL` to a deployed
backend when needed. For live testnet use, fund a Stellar account and set
`STELLAR_PUBLIC_KEY`. Never put a secret key in source code or commit it.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Examples

Register an agent after funding its public key on the Stellar testnet:

```bash
export STELLAR_PUBLIC_KEY=G...
export AGENT_ENDPOINT=https://your-public-agent.example/task
python register_agent.py
```

Submit a task and poll until it reaches a terminal status. The backend task
endpoint accepts tasks only when the configured API supports the selected
wallet and coordinator services:

```bash
export STELLAR_PUBLIC_KEY=G...
python submit_and_poll.py "Summarize Stellar smart contract security"
```

Run a local callback receiver:

```bash
export WEBHOOK_SECRET='replace-with-a-shared-secret'
python webhook_receiver.py
```

The receiver verifies `X-Ainet-Signature` as `sha256=<hex HMAC-SHA256>` over
the raw request body. The current ai-net API does not send task webhooks; use
this receiver with an application or delivery adapter that implements that
contract.

Verify an Ed25519 signature over a Stellar transaction hash. The JSON input
maps each signer public key to its base64 signature; obtain that mapping from
your trusted transaction-inspection flow:

```bash
python verify_stellar_signature.py transaction-signatures.json
```

This verifies signature cryptography only. It does not establish ledger
inclusion, transaction success, signer authorization, or payment settlement.

LangChain integrations:

```bash
export STELLAR_PUBLIC_KEY=G...
python langchain_tool.py "Explain Soroban storage TTL"
python multi_agent_workflow.py "Review this prompt for security and clarity"
```

The workflow submits independent specialist prompts to ai-net and collects
their results; it does not create a persistent LangChain agent runtime.
"""Verify Ed25519 signatures over a Stellar transaction hash."""

import base64
import json
import sys

from stellar_sdk import Keypair


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python verify_stellar_signature.py input.json")

    with open(sys.argv[1], encoding="utf-8") as signature_file:
        payload = json.load(signature_file)

    transaction_hash = bytes.fromhex(payload["transactionHash"])
    if len(transaction_hash) != 32:
        raise ValueError("transactionHash must contain 32 bytes of hex")

    all_valid = True
    for entry in payload["signatures"]:
        keypair = Keypair.from_public_key(entry["publicKey"])
        signature = base64.b64decode(entry["signature"], validate=True)
        try:
            keypair.verify(transaction_hash, signature)
            print(f"valid: {entry['publicKey']}")
        except Exception:
            all_valid = False
            print(f"invalid: {entry['publicKey']}")

    if not payload["signatures"] or not all_valid:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
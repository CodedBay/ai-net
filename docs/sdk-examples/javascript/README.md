# Browser JavaScript Example

This Vite page demonstrates connecting Freighter, submitting a task through
the v2 REST API, streaming task updates over WebSocket, and displaying payment
history. It requires Node.js 20+, a running ai-net backend, and the Freighter
browser extension. The backend API must permit the browser origin through its
CORS configuration.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open the URL printed by Vite, connect a testnet Freighter wallet, and submit a
prompt. Set `VITE_API_URL` in `.env.local` when the backend is not at
`http://localhost:3000`.

The WebSocket server authenticates the task stream using the connected wallet
as the first message. The payment-history endpoint returns the backend's local
reconciliation records; it does not itself prove on-chain settlement.
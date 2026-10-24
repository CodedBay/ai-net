import { requestAccess } from "@stellar/freighter-api";
import "./style.css";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:3000").replace(/\/$/, "");
const walletStatus = document.querySelector("#wallet");
const eventOutput = document.querySelector("#events");
const paymentsList = document.querySelector("#payments");
let walletPublicKey = "";

document.querySelector("#connect").addEventListener("click", async () => {
  try {
    const access = await requestAccess();
    if (access.error) throw new Error(access.error.message || "Wallet access was denied");
    walletPublicKey = access.address;
    walletStatus.textContent = `Connected: ${walletPublicKey}`;
  } catch (error) {
    walletStatus.textContent = error.message;
  }
});

document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletPublicKey) {
    walletStatus.textContent = "Connect Freighter before submitting a task.";
    return;
  }

  const prompt = document.querySelector("#prompt").value.trim();
  eventOutput.textContent = "Submitting task...";
  try {
    const response = await fetch(`${API_URL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-Version": "2.0" },
      body: JSON.stringify({ prompt, walletPublicKey }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || "Task submission failed");
    connectToTask(payload.data.taskId);
  } catch (error) {
    eventOutput.textContent = error.message;
  }
});

function connectToTask(taskId) {
  const streamUrl = new URL(`/tasks/${encodeURIComponent(taskId)}/stream`, API_URL);
  streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(streamUrl);
  eventOutput.textContent = `Connecting to ${taskId}...`;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ walletPublicKey }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    eventOutput.textContent += `\n${JSON.stringify(message, null, 2)}`;
  });
  socket.addEventListener("error", () => {
    eventOutput.textContent += "\nWebSocket connection error";
  });
  socket.addEventListener("close", ({ code }) => {
    eventOutput.textContent += `\nStream closed (${code})`;
  });
}

document.querySelector("#load-payments").addEventListener("click", async () => {
  paymentsList.replaceChildren();
  try {
    const response = await fetch(`${API_URL}/api/payments`);
    if (!response.ok) throw new Error(`Payment request failed (${response.status})`);
    const { payments } = await response.json();
    for (const payment of payments) {
      const item = document.createElement("li");
      item.textContent = `${payment.taskId} | ${payment.status} | ${payment.amountStroops} stroops | ${payment.txHash || "no tx hash"}`;
      paymentsList.append(item);
    }
  } catch (error) {
    const item = document.createElement("li");
    item.textContent = error.message;
    paymentsList.append(item);
  }
});
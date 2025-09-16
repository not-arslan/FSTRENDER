import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import cors from "cors";
import { SmartAPI } from "smartapi-javascript";  // Official Angel One SDK

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(cors());

// Load creds
const { ANGELONE_API_KEY, ANGELONE_CLIENT_ID, ANGELONE_PASSWORD, ANGELONE_TOTP } = process.env;

let angelOneConnected = false;
let clients = [];

// Health API
app.get("/api/health", (req, res) => {
  res.json({ angelone_connected: angelOneConnected });
});

// WebSocket (frontend ↔ backend)
wss.on("connection", (ws) => {
  console.log("Frontend connected");
  clients.push(ws);

  ws.on("close", () => {
    clients = clients.filter((c) => c !== ws);
  });

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "subscribe") {
        console.log("Frontend wants:", parsed.symbol);
        // You can map symbol -> token here if needed
      }
    } catch (e) {
      console.error("Invalid WS message:", msg);
    }
  });
});

// Broadcast helper
function broadcast(data) {
  clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(data));
    }
  });
}

// ---- Angel One SmartAPI ----
const smart_api = new SmartAPI({ api_key: ANGELONE_API_KEY });

async function connectAngelOne() {
  try {
    const session = await smart_api.generateSession(
      ANGELONE_CLIENT_ID,
      ANGELONE_PASSWORD,
      ANGELONE_TOTP
    );

    console.log("✅ Angel One Session Created");
    angelOneConnected = true;

    // Subscribe to market data WS
    const ws = await smart_api.getMarketDataWs();

    ws.on("open", () => {
      console.log("📡 Angel One WS Connected");

      // Example subscription: NIFTY (26000), BANKNIFTY (26009)
      ws.subscribe({ exchangeType: 1, tokens: ["26000", "26009"] });
    });

    ws.on("tick", (data) => {
      broadcast({ type: "market_update", data });
    });

    ws.on("close", () => {
      console.log("❌ Angel One WS Closed");
      angelOneConnected = false;
    });

    ws.on("error", (err) => {
      console.error("WS Error:", err);
      angelOneConnected = false;
    });
  } catch (err) {
    console.error("Angel One login error:", err);
    angelOneConnected = false;
  }
}

// Start backend
server.listen(25602, async () => {
  console.log("🚀 Backend running at http://localhost:25602");
  await connectAngelOne();
});

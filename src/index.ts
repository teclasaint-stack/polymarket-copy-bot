import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import { ClobClient } from "@polymarket/clob-client";

const {
  PORT = "3000",
  LEADER_WALLET,
  MAX_SINGLE_BET_USDC = "10",
  COPY_MULTIPLIER = "1",
  POLYMARKET_DATA_API = "https://data-api.polymarket.com",
  POLYMARKET_CLOB_HOST = "https://clob.polymarket.com",
  PRIVATE_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

if (!LEADER_WALLET || !PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required environment variables");
}

const maxSingle = Number(MAX_SINGLE_BET_USDC);
const multiplier = Number(COPY_MULTIPLIER);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("OK"));

app.post("/cron/copy", async (_req, res) => {
  try {
    const url = `${POLYMARKET_DATA_API}/activity?user=${LEADER_WALLET}&type=TRADE&limit=25`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Failed to fetch activity");
    const items: any[] = await r.json();

    const trades = items.reverse();
    let copiedCount = 0;

    for (const t of trades) {
      const leaderTradeId = String(
        t.transactionHash || `${t.createdAt}-${t.conditionId}-${t.side}-${t.size}`
      );

      const { data: existing } = await supabase
        .from("copied_trades")
        .select("leader_trade_id")
        .eq("leader_trade_id", leaderTradeId)
        .limit(1);

      if (existing && existing.length > 0) continue;

      if (String(t.side).toUpperCase() !== "BUY") {
        await supabase.from("copied_trades").insert({
          leader_trade_id: leaderTradeId,
          leader_wallet: LEADER_WALLET,
          payload: t
        });
        continue;
      }

      const leaderUsdc = Number(t.usdcSize ?? 0);
      if (leaderUsdc <= 0) continue;

      const intendedUsdc = Math.min(leaderUsdc * multiplier, maxSingle);
      const tokenID = t.asset;
      const price = Number(t.price);

      if (!tokenID || !price || price <= 0 || price >= 1) continue;

      const size = intendedUsdc / price;

      const client = new ClobClient(POLYMARKET_CLOB_HOST);
      const order = await client.createAndPostOrder({
        tokenID,
        side: "BUY",
        price,
        size,
        orderType: "GTC"
      }, PRIVATE_KEY);

      await supabase.from("copied_trades").insert({
        leader_trade_id: leaderTradeId,
        leader_wallet: LEADER_WALLET,
        payload: { leader: t, order }
      });

      copiedCount++;
    }

    res.json({ ok: true, copiedCount });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Server running on ${PORT}`);
});

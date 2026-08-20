export default {
  // Triggered automatically by Cloudflare Cron Schedule (e.g. every 2 minutes)
  async scheduled(event, env, ctx) {
    try {
      await processBlitzSignal(env);
    } catch (e) {
      console.error("Cron Execution Error:", e.message);
    }
  },

  // Manual trigger / API endpoint handler
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      try {
        const result = await processBlitzSignal(env);
        return Response.json(result);
      } catch (err) {
        return Response.json({
          error: "Execution Failed",
          details: err.message,
          stack: err.stack
        }, { status: 500 });
      }
    }

    if (url.pathname === "/history") {
      try {
        if (!env.DB) return Response.json({ error: "D1 Database binding missing" }, { status: 500 });
        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20"
        ).all();
        return Response.json(results);
      } catch (err) {
        return Response.json({ error: "D1 Query Failed", details: err.message }, { status: 500 });
      }
    }

    return new Response("Production IQ Option Blitz Bot Active. Use /trigger to test.", { status: 200 });
  }
};

// 10 Supported High-Liquidity Crypto Assets with Configurable Expiry Profiles
const TARGET_PAIRS = [
  { symbol: "BTCUSDT", display: "Bitcoin (BTC/USD)", expiryMinutes: 2 },
  { symbol: "ETHUSDT", display: "Ethereum (ETH/USD)", expiryMinutes: 2 },
  { symbol: "SOLUSDT", display: "Solana (SOL/USD)", expiryMinutes: 3 },
  { symbol: "XRPUSDT", display: "Ripple (XRP/USD)", expiryMinutes: 3 },
  { symbol: "LTCUSDT", display: "Litecoin (LTC/USD)", expiryMinutes: 2 },
  { symbol: "DOGEUSDT", display: "Dogecoin (DOGE/USD)", expiryMinutes: 3 },
  { symbol: "ADAUSDT", display: "Cardano (ADA/USD)", expiryMinutes: 3 },
  { symbol: "TRXUSDT", display: "Tron (TRX/USD)", expiryMinutes: 5 },
  { symbol: "DOTUSDT", display: "Polkadot (DOT/USD)", expiryMinutes: 3 },
  { symbol: "BCHUSDT", display: "Bitcoin Cash (BCH/USD)", expiryMinutes: 2 }
];

async function processBlitzSignal(env) {
  // Step 1: Run D1 Database Maintenance Routine (Auto-delete records > 4 days old)
  if (env.DB) {
    ctxDatabaseCleanup(env.DB).catch(err => console.warn("D1 Cleanup Warning:", err.message));
  }

  // Step 2: Parallel Data Fetching for 10 pairs (10 subrequests total)
  const marketPromises = TARGET_PAIRS.map(pair => fetchPairData(pair));
  const marketResults = await Promise.all(marketPromises);

  // Step 3: Quantitative Technical Analysis Pipeline
  const validSignals = [];
  for (const asset of marketResults) {
    if (!asset.success || !asset.candles || asset.candles.length < 20) continue;

    const signal = analyzeMarket(asset);
    if (signal && !signal.skipTrade && signal.direction !== "WAIT" && signal.confidence >= 0.75) {
      validSignals.push(signal);
    }
  }

  // Calculate Entry Time (Strictly 2 Minutes in advance for execution prep)
  const now = new Date();
  const entryDate = new Date(now.getTime() + 2 * 60000); // +2 minutes lead time
  const entryTimeStr = entryDate.toLocaleTimeString('en-US', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // If no setup satisfies the strict quantitative criteria, exit safely
  if (validSignals.length === 0) {
    return {
      status: "Filtered",
      message: "Capital Safe: No pair meets high-accuracy threshold (>=75%). Trade skipped.",
      scannedPairs: TARGET_PAIRS.length
    };
  }

  // Select the single highest-confidence setup across all 10 assets
  validSignals.sort((a, b) => b.confidence - a.confidence);
  let bestSignal = validSignals[0];

  // Step 4: MANDATORY Workers AI Verification Gatekeeper
  let aiVerified = false;
  if (env.AI) {
    try {
      const prompt = `System: You are an elite quantitative binary options trader protecting capital.
Asset: ${bestSignal.display}. Price: $${bestSignal.price}. Indicator Signal: ${bestSignal.direction}. Confidence Score: ${bestSignal.confidence}. Technical Setup: ${bestSignal.reasoning}.
Task: Strictly validate if this 1m-5m Blitz option trend is safe. Reply ONLY in JSON with exact format: {"direction": "CALL"|"PUT"|"WAIT", "confidence": 0.75-0.95, "reasoning": "1 short sentence"}`;

      // Try Llama 3.3 70b, fallback to 3.1 8b
      let aiResponse;
      try {
        aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { prompt });
      } catch (e) {
        aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt });
      }

      if (aiResponse && aiResponse.response) {
        const clean = aiResponse.response.trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.direction === "CALL" || parsed.direction === "PUT") {
            bestSignal.direction = parsed.direction;
            bestSignal.confidence = parsed.confidence ? Math.min(0.95, parseFloat(parsed.confidence)) : bestSignal.confidence;
            bestSignal.reasoning = parsed.reasoning || bestSignal.reasoning;
            aiVerified = true;
          } else {
            // AI returned "WAIT"
            bestSignal.skipTrade = true;
            bestSignal.reasoning = parsed.reasoning || "AI rejected trade due to market instability.";
          }
        }
      }
    } catch (aiErr) {
      console.warn("AI Gatekeeper Error:", aiErr.message);
      bestSignal.skipTrade = true; // MANDATORY AI REQUIREMENT: If AI fails, skip trade to preserve capital.
    }
  } else {
    // If env.AI is missing, enforce mandatory rule: skip trade
    bestSignal.skipTrade = true;
    bestSignal.reasoning = "Mandatory AI validation environment missing. Trade aborted for safety.";
  }

  // Abort execution if AI did not explicitly approve
  if (bestSignal.skipTrade || !aiVerified) {
    return {
      status: "Skipped",
      message: "Mandatory AI validation failed or rejected setup. Capital preserved.",
      reasoning: bestSignal.reasoning,
      selectedPair: bestSignal.display
    };
  }

  // Calculate Expiration & Martingale Levels based on asset settings
  const expiryMin = bestSignal.expiryMinutes;
  const expiryTimeStr = getOffsetTime(entryDate, expiryMin);
  const mg1TimeStr = getOffsetTime(entryDate, expiryMin);
  const mg2TimeStr = getOffsetTime(entryDate, expiryMin * 2);

  // Step 5: Send High-Precision Telegram Alert
  let telegramStatus = "Skipped (Missing Tokens)";
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const isCall = bestSignal.direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🎯 *IQ OPTION BLITZ HIGH-WIN SIGNAL*

🎫 *Asset:* 🪙 ${bestSignal.display}
⚡ *Data Source:* ${bestSignal.source}
⏳ *Trade Expiry:* ${expiryMin} Minute(s) (Dynamic)
➡️ *Entry Time:* ${entryTimeStr} (WAT - In 2 Mins)
🏁 *Close Time:* ${expiryTimeStr} (WAT)
📊 *Direction:* ${directionEmoji}
🔥 *Win Probability:* ${(bestSignal.confidence * 100).toFixed(0)}%

↪️ *Martingale Recovery Schedule:*
 • Level 1 → ${mg1TimeStr}
 • Level 2 → ${mg2TimeStr}

💡 *Quant & AI Analysis:* ${bestSignal.reasoning}
⚠️ *Risk Note:* Execute precisely at candle start. Skip if market spikes before entry.
    `.trim();

    await sendTelegramMessage(env, message);
    telegramStatus = "Sent Successfully";
  }

  // Step 6: Log Approved Signal into Cloudflare D1
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO signals (symbol, signal, confidence, price, time_frame, entry_time, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(bestSignal.symbol, bestSignal.direction, bestSignal.confidence, bestSignal.price, `${expiryMin}M`, entryTimeStr, bestSignal.reasoning).run();
    } catch (dbErr) {
      console.warn("D1 Insert Error:", dbErr.message);
    }
  }

  return {
    status: "Success",
    scannedPairs: TARGET_PAIRS.length,
    selectedPair: bestSignal.display,
    direction: bestSignal.direction,
    confidence: bestSignal.confidence,
    entryTime: entryTimeStr,
    expiryMinutes: expiryMin,
    telegramStatus
  };
}

// Fetch Market Data Helper (Bybit -> Binance -> Error Fallback)
async function fetchPairData(pair) {
  try {
    const bybitRes = await fetch(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair.symbol}&interval=1&limit=30`,
      { headers: { "Accept": "application/json" } }
    );
    if (bybitRes.ok) {
      const bData = await bybitRes.json();
      if (bData.retCode === 0 && bData.result && bData.result.list) {
        const candles = bData.result.list.map(c => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        })).reverse();
        return { success: true, symbol: pair.symbol, display: pair.display, expiryMinutes: pair.expiryMinutes, source: "BYBIT", candles };
      }
    }
    throw new Error("Bybit unreachable");
  } catch (err) {
    try {
      const binanceRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair.symbol}&interval=1m&limit=30`);
      if (binanceRes.ok) {
        const bData = await binanceRes.json();
        const candles = bData.map(c => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));
        return { success: true, symbol: pair.symbol, display: pair.display, expiryMinutes: pair.expiryMinutes, source: "BINANCE", candles };
      }
    } catch (e) {
      return { success: false, symbol: pair.symbol };
    }
  }
}

// Quantitative Technical Analysis Matrix (Strict Accuracy Rules)
function analyzeMarket(asset) {
  const candles = asset.candles;
  const currentPrice = candles[candles.length - 1].close;
  const closes = candles.map(c => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(candles, 10);

  const atrPercent = (atr / currentPrice) * 100;
  const lastCandle = candles[candles.length - 1];
  const candleBodySize = Math.abs(lastCandle.close - lastCandle.open);
  const candleRange = lastCandle.high - lastCandle.low;

  let direction = "WAIT";
  let confidence = 0.50;
  let reasoning = "";
  let skipTrade = false;

  // Rule 1: Tight Range & Dead Volatility Protection (Protect against unpredictable wicks)
  if (atrPercent < 0.018 || candleRange === 0) {
    skipTrade = true;
    reasoning = `Ranging market/dead volatility (ATR: ${atrPercent.toFixed(4)}%). High fallout risk.`;
  } else if (candleBodySize < (candleRange * 0.45)) {
    // Rule 2: Rejection / Indecision Wick Protection (No Dojis or weak bodies)
    skipTrade = true;
    reasoning = `Candle indecision detected (body size < 45% of total wick range).`;
  } else {
    const isEmaBullish = ema9 > ema21;
    const isEmaBearish = ema9 < ema21;

    // Rule 3: Trend & Momentum Confluence Matrix
    if (isEmaBullish && rsi >= 54 && rsi <= 68) {
      direction = "CALL";
      confidence = Math.min(0.92, 0.76 + (rsi - 50) * 0.01);
      reasoning = `Solid Bullish Trend (EMA 9>21), clean RSI momentum (${rsi.toFixed(1)}), strong full body.`;
    } else if (isEmaBearish && rsi <= 46 && rsi >= 32) {
      direction = "PUT";
      confidence = Math.min(0.92, 0.76 + (50 - rsi) * 0.01);
      reasoning = `Solid Bearish Downside (EMA 9<21), RSI downside confirmation (${rsi.toFixed(1)}).`;
    } else {
      skipTrade = true;
      reasoning = `Overbought/Oversold exhaustion or flat EMAs (RSI: ${rsi.toFixed(1)}).`;
    }
  }

  return {
    symbol: asset.symbol,
    display: asset.display,
    expiryMinutes: asset.expiryMinutes,
    source: asset.source,
    price: currentPrice,
    direction,
    confidence,
    reasoning,
    skipTrade
  };
}

// Indicator Helpers (< 1ms execution)
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] * k) + (ema * (1 - k));
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calculateATR(candles, period = 10) {
  let trSum = 0;
  const slice = candles.slice(-period);
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    trSum += tr;
  }
  return trSum / (slice.length - 1);
}

// Database Auto-Cleanup Helper (Keep last 4 days)
async function ctxDatabaseCleanup(db) {
  await db.prepare(
    "DELETE FROM signals WHERE timestamp < datetime('now', '-4 days')"
  ).run();
}

function getOffsetTime(baseDate, addMinutes) {
  const d = new Date(baseDate.getTime() + addMinutes * 60000);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "Markdown"
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API Error: ${errText}`);
  }
}


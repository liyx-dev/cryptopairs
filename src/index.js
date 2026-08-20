export default {
  // Triggered automatically by Cloudflare Cron Schedule
  async scheduled(event, env, ctx) {
    try {
      await processBlitzSignal(env);
    } catch (e) {
      console.error("Cron Execution Error:", e.message);
    }
  },

  // Allows manual trigger via URL (e.g. /trigger)
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      try {
        const result = await processBlitzSignal(env);
        return Response.json(result);
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: "Execution Failed",
            details: err.message,
            stack: err.stack
          }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/history") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20"
        ).all();
        return Response.json(results);
      } catch (err) {
        return Response.json({ error: "D1 Query Failed", details: err.message }, { status: 500 });
      }
    }

    return new Response("IQ Option Multi-Pair Blitz Bot Active. Use /trigger to test.", { status: 200 });
  }
};

// 10 Supported High-Liquidity Blitz Crypto Pairs
const TARGET_PAIRS = [
  { symbol: "BTCUSDT", display: "Bitcoin (BTC/USD)" },
  { symbol: "ETHUSDT", display: "Ethereum (ETH/USD)" },
  { symbol: "SOLUSDT", display: "Solana (SOL/USD)" },
  { symbol: "XRPUSDT", display: "Ripple (XRP/USD)" },
  { symbol: "LTCUSDT", display: "Litecoin (LTC/USD)" },
  { symbol: "DOGEUSDT", display: "Dogecoin (DOGE/USD)" },
  { symbol: "ADAUSDT", display: "Cardano (ADA/USD)" },
  { symbol: "TRXUSDT", display: "Tron (TRX/USD)" },
  { symbol: "DOTUSDT", display: "Polkadot (DOT/USD)" },
  { symbol: "BCHUSDT", display: "Bitcoin Cash (BCH/USD)" }
];

async function processBlitzSignal(env) {
  // 1. Fetch live 1-min candles for all 10 pairs in parallel (Uses 10 subrequests)
  const marketPromises = TARGET_PAIRS.map(pair => fetchPairData(pair));
  const marketResults = await Promise.all(marketPromises);

  // 2. Quantitative Technical Analysis Loop
  const validSignals = [];

  for (const asset of marketResults) {
    if (!asset.success || asset.candles.length < 20) continue;

    const signal = analyzeMarket(asset);
    if (signal && !signal.skipTrade && signal.direction !== "WAIT") {
      validSignals.push(signal);
    }
  }

  // Calculate Entry Time for Next 1-minute candle in WAT
  const now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  const entryTime = now.toLocaleTimeString('en-US', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // If no pair meets the strict quantitative threshold, exit safely
  if (validSignals.length === 0) {
    return {
      status: "Filtered",
      message: "No trade meets high-accuracy threshold across all 10 pairs.",
      scannedPairs: TARGET_PAIRS.length
    };
  }

  // Sort signals by highest confidence and pick the top setup
  validSignals.sort((a, b) => b.confidence - a.confidence);
  let bestSignal = validSignals[0];

  // 3. Workers AI Double Verification for the Best Signal
  if (env.AI) {
    try {
      const prompt = `System: IQ Blitz Option Signal Validator.
Pair: ${bestSignal.display}. Price: $${bestSignal.price}. Signal: ${bestSignal.direction}. Confidence: ${bestSignal.confidence}. Reason: ${bestSignal.reasoning}.
Validate if this short-term trend is safe for 60s Blitz. Reply STRICTLY in valid JSON: {"direction": "CALL"|"PUT"|"WAIT", "confidence": 0.75-0.95, "reasoning": "1 short sentence"}`;

      const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { prompt });
      if (aiResponse && aiResponse.response) {
        const clean = aiResponse.response.trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.direction === "WAIT") {
            bestSignal.skipTrade = true;
          } else {
            bestSignal.direction = parsed.direction || bestSignal.direction;
            bestSignal.confidence = parsed.confidence ? Math.min(0.95, parseFloat(parsed.confidence)) : bestSignal.confidence;
            bestSignal.reasoning = parsed.reasoning || bestSignal.reasoning;
          }
        }
      }
    } catch (aiErr) {
      console.warn("AI Model bypassed, executing quantitative signal:", aiErr.message);
    }
  }

  if (bestSignal.skipTrade) {
    return { status: "Filtered", message: "AI downgraded signal to WAIT.", bestSignal };
  }

  // 4. Send Telegram Alert
  let telegramStatus = "Skipped (Missing Tokens)";
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const isCall = bestSignal.direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🔔 *IQ OPTION BLITZ SIGNAL!*

🎫 *Asset:* 🪙 ${bestSignal.display} (Blitz)
⚡ *Source:* ${bestSignal.source} Feed
⏳ *Expiration:* 1 Minute
➡️ *Entry Time:* ${entryTime} (WAT)
📈 *Direction:* ${directionEmoji}
🎯 *Confidence:* ${(bestSignal.confidence * 100).toFixed(0)}%

↪️ *Martingale Recovery:*
 Level 1 → ${getOffsetTime(now, 1)}
 Level 2 → ${getOffsetTime(now, 2)}

💡 *Reason:* ${bestSignal.reasoning}
    `.trim();

    await sendTelegramMessage(env, message);
    telegramStatus = "Sent Successfully";
  }

  // 5. Log Signal into Cloudflare D1
  if (env.DB) {
    await env.DB.prepare(
      "INSERT INTO signals (symbol, signal, confidence, price, time_frame, entry_time, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(bestSignal.symbol, bestSignal.direction, bestSignal.confidence, bestSignal.price, "1M", entryTime, bestSignal.reasoning).run();
  }

  return {
    status: "Success",
    scannedPairs: TARGET_PAIRS.length,
    selectedPair: bestSignal.display,
    direction: bestSignal.direction,
    confidence: bestSignal.confidence,
    entryTime,
    telegramStatus
  };
}

// Fetch Market Data Helper (Bybit with Binance Fallback)
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
        return { success: true, symbol: pair.symbol, display: pair.display, source: "BYBIT", candles };
      }
    }
    throw new Error("Bybit failed");
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
        return { success: true, symbol: pair.symbol, display: pair.display, source: "BINANCE", candles };
      }
    } catch (e) {
      return { success: false, symbol: pair.symbol };
    }
  }
}

// Quantitative Analysis Matrix Engine
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

  // Rule 1: Tight Range / Squeeze Protection
  if (atrPercent < 0.015 || candleRange === 0) {
    skipTrade = true;
    reasoning = `Ranging market (ATR: ${atrPercent.toFixed(4)}%). Fallout risk high.`;
  } else {
    const isEmaBullish = ema9 > ema21;
    const isEmaBearish = ema9 < ema21;

    if (isEmaBullish && rsi > 52 && rsi < 68 && candleBodySize > (candleRange * 0.4)) {
      direction = "CALL";
      confidence = Math.min(0.92, 0.72 + (rsi - 50) * 0.01);
      reasoning = `EMA Bullish Cross, strong RSI (${rsi.toFixed(1)}), momentum momentum candle.`;
    } else if (isEmaBearish && rsi < 48 && rsi > 32 && candleBodySize > (candleRange * 0.4)) {
      direction = "PUT";
      confidence = Math.min(0.92, 0.72 + (50 - rsi) * 0.01);
      reasoning = `EMA Bearish Cross, RSI weakness (${rsi.toFixed(1)}), downward push.`;
    } else {
      skipTrade = true;
      reasoning = `Neutral or exhausted price action (RSI: ${rsi.toFixed(1)}).`;
    }
  }

  return {
    symbol: asset.symbol,
    display: asset.display,
    source: asset.source,
    price: currentPrice,
    direction,
    confidence,
    reasoning,
    skipTrade
  };
}

// Indicator Logic
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


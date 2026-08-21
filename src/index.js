// ============================================================
// BLITZ SIGNAL BOT — UPGRADED
// Dynamic expiry based on volatility, non-OTC market data,
// reduced signal-to-entry lag, multi-asset support.
//
// IMPORTANT: This trades signals meant for the REGULAR (non-OTC)
// pairs on IQ Option — e.g. "Bitcoin" / "Ethereum" — NOT the
// "(OTC)" labeled versions. OTC runs on a different price feed
// than Binance/Bybit, so signals from real market data do not
// apply to OTC charts. Only place trades on non-OTC pairs when
// using this bot's signals, during real market hours.
// ============================================================

const TARGET_PAIRS = [
  { symbol: "BTCUSDT", display: "Bitcoin (BTC/USD)" },
  { symbol: "ETHUSDT", display: "Ethereum (ETH/USD)" },
  { symbol: "SOLUSDT", display: "Solana (SOL/USD)" },
  { symbol: "XRPUSDT", display: "Ripple (XRP/USD)" },
  { symbol: "DOGEUSDT", display: "Dogecoin (DOGE/USD)" },
];

// Dynamic expiry bounds (minutes). The system picks within this
// range based on current volatility instead of a hardcoded value.
const MIN_EXPIRY = 1;
const MAX_EXPIRY = 3;

// How far ahead of "now" the entry time is set. Kept short and
// tied to actual computation time rather than a padded guess.
const ENTRY_LEAD_SECONDS = 20;

export default {
  async scheduled(event, env, ctx) {
    try {
      await processBlitzSignal(env);
    } catch (e) {
      console.error("Cron Execution Error:", e.message);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      try {
        const result = await processBlitzSignal(env);
        return Response.json(result);
      } catch (err) {
        return Response.json(
          { error: "Execution Failed", details: err.message, stack: err.stack },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/history") {
      try {
        if (!env.DB) return Response.json({ error: "D1 binding missing" }, { status: 500 });
        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20"
        ).all();
        return Response.json(results);
      } catch (err) {
        return Response.json({ error: "D1 Query Failed", details: err.message }, { status: 500 });
      }
    }

    return new Response("Blitz Signal Bot Active (non-OTC pairs). Use /trigger to test.", { status: 200 });
  },
};

async function processBlitzSignal(env) {
  const startTime = Date.now();

  // Optional lightweight cleanup — cheap, runs occasionally
  if (env.DB) {
    ctxDatabaseCleanup(env.DB).catch((err) => console.warn("D1 Cleanup Warning:", err.message));
  }

  // Fetch all pairs in parallel (well within 50 subrequest limit)
  const marketResults = await Promise.all(TARGET_PAIRS.map(fetchPairData));

  const validSignals = [];
  for (const asset of marketResults) {
    if (!asset.success || !asset.candles || asset.candles.length < 21) continue;
    const signal = analyzeMarket(asset);
    if (signal && !signal.skipTrade && signal.direction !== "WAIT") {
      validSignals.push(signal);
    }
  }

  if (validSignals.length === 0) {
    return {
      status: "Filtered",
      message: "No pair met signal criteria this cycle. No trade sent.",
      scannedPairs: TARGET_PAIRS.length,
      computeMs: Date.now() - startTime,
    };
  }

  validSignals.sort((a, b) => b.confidence - a.confidence);
  const bestSignal = validSignals[0];

  // Dynamic expiry: higher volatility -> shorter expiry (less time
  // for the move to reverse), lower volatility -> slightly longer
  // (needs more time to develop a real move). Clamped to bounds.
  const expiryMinutes = computeDynamicExpiry(bestSignal.atrPercent);

  // Entry time: rounded up to the next clean minute mark so it's
  // trackable on a clock/chart, rather than a mid-minute second value.
  const now = new Date();
  const entryDate = new Date(now.getTime() + ENTRY_LEAD_SECONDS * 1000);
  entryDate.setSeconds(0, 0);
  entryDate.setMinutes(entryDate.getMinutes() + 1);
  const entryTimeStr = formatTime(entryDate);
  const expiryTimeStr = getOffsetTime(entryDate, expiryMinutes);

  let telegramStatus = "Skipped (Missing Tokens)";
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const isCall = bestSignal.direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🎯 *BLITZ SIGNAL*

🎫 *Asset:* ${bestSignal.display}
⚡ *Source:* ${bestSignal.source}
⏳ *Expiry (dynamic):* ${expiryMinutes} Minute(s)
➡️ *Entry Time:* ${entryTimeStr} (WAT)
🏁 *Close Time:* ${expiryTimeStr} (WAT)
📊 *Direction:* ${directionEmoji}
🔥 *Confidence:* ${(bestSignal.confidence * 100).toFixed(0)}%
📈 *Volatility (ATR%):* ${bestSignal.atrPercent.toFixed(4)}%

💡 *Reasoning:* ${bestSignal.reasoning}
    `.trim();

    await sendTelegramMessage(env, message);
    telegramStatus = "Sent Successfully";
  }

  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO signals (symbol, signal, confidence, price, time_frame, entry_time, reasoning, atr_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          bestSignal.symbol,
          bestSignal.direction,
          bestSignal.confidence,
          bestSignal.price,
          `${expiryMinutes}M`,
          entryTimeStr,
          bestSignal.reasoning,
          bestSignal.atrPercent
        )
        .run();
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
    expiryMinutes,
    entryTime: entryTimeStr,
    telegramStatus,
    computeMs: Date.now() - startTime,
  };
}

// Maps volatility to an expiry duration within [MIN_EXPIRY, MAX_EXPIRY].
// Higher ATR% -> shorter expiry. Thresholds are a starting point;
// they have NOT been validated against outcomes — tune only after
// you have real performance data to tune against.
function computeDynamicExpiry(atrPercent) {
  if (atrPercent >= 0.05) return MIN_EXPIRY;
  if (atrPercent >= 0.03) return 2;
  return MAX_EXPIRY;
}

async function fetchPairData(pair) {
  try {
    const bybitRes = await fetch(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair.symbol}&interval=1&limit=30`,
      { headers: { Accept: "application/json" } }
    );
    if (bybitRes.ok) {
      const bData = await bybitRes.json();
      if (bData.retCode === 0 && bData.result?.list) {
        const candles = bData.result.list
          .map((c) => ({
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
          }))
          .reverse();
        return { success: true, symbol: pair.symbol, display: pair.display, source: "BYBIT", candles };
      }
    }
    throw new Error("Bybit unreachable");
  } catch {
    try {
      const binanceRes = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${pair.symbol}&interval=1m&limit=30`
      );
      if (binanceRes.ok) {
        const bData = await binanceRes.json();
        const candles = bData.map((c) => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }));
        return { success: true, symbol: pair.symbol, display: pair.display, source: "BINANCE", candles };
      }
    } catch {
      return { success: false, symbol: pair.symbol };
    }
  }
  return { success: false, symbol: pair.symbol };
}

function analyzeMarket(asset) {
  const candles = asset.candles;
  const currentPrice = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(candles, 10);
  const atrPercent = (atr / currentPrice) * 100;

  const lastCandle = candles[candles.length - 1];
  const candleBodySize = Math.abs(lastCandle.close - lastCandle.open);
  const candleRange = lastCandle.high - lastCandle.low;

  let direction = "WAIT";
  let confidence = 0.5;
  let reasoning = "";
  let skipTrade = false;

  if (atrPercent < 0.018 || candleRange === 0) {
    skipTrade = true;
    reasoning = `Ranging/dead volatility (ATR: ${atrPercent.toFixed(4)}%).`;
  } else if (candleBodySize < candleRange * 0.45) {
    skipTrade = true;
    reasoning = `Candle indecision (body < 45% of range).`;
  } else {
    const isEmaBullish = ema9 > ema21;
    const isEmaBearish = ema9 < ema21;

    if (isEmaBullish && rsi >= 54 && rsi <= 68) {
      direction = "CALL";
      confidence = Math.min(0.92, 0.76 + (rsi - 50) * 0.01);
      reasoning = `Bullish EMA cross, RSI ${rsi.toFixed(1)}, strong body.`;
    } else if (isEmaBearish && rsi <= 46 && rsi >= 32) {
      direction = "PUT";
      confidence = Math.min(0.92, 0.76 + (50 - rsi) * 0.01);
      reasoning = `Bearish EMA cross, RSI ${rsi.toFixed(1)}, strong body.`;
    } else {
      skipTrade = true;
      reasoning = `No clean confluence (RSI: ${rsi.toFixed(1)}).`;
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
    skipTrade,
    atrPercent,
  };
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calculateRSI(prices, period = 14) {
  let gains = 0,
    losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
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

async function ctxDatabaseCleanup(db) {
  await db.prepare("DELETE FROM signals WHERE timestamp < datetime('now', '-4 days')").run();
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function getOffsetTime(baseDate, addMinutes) {
  const d = new Date(baseDate.getTime() + addMinutes * 60000);
  return formatTime(d);
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API Error: ${errText}`);
  }
}


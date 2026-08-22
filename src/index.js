// src/index.js

// Configuration
const CONFIG = {
  DERIV_TOKEN: "pat_bcc7e10e3436a29fde76b8eaa607a932251a0d84c28ed775a705c76e38702aa2",
  TELEGRAM_BOT_TOKEN: "8862813101:AAFfouRH6gmGVcPBrX8yyZxOFk6VPwjqJwg",
  TELEGRAM_CHAT_ID: "8737403387",
  TIMEZONE_OFFSET: 1, // Nigeria UTC+1
  PAIRS: ["frxEURUSD", "frxGBPUSD", "frxUSDJPY"], // add more pairs here
};

// Time helpers
function getNextCycleTimes() {
  const now = new Date();
  const nigeriaOffset = CONFIG.TIMEZONE_OFFSET * 60 * 60 * 1000;
  const localNow = new Date(now.getTime() + nigeriaOffset);

  const nextEntry = new Date(Math.ceil(localNow.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000));
  const signalTime = new Date(nextEntry.getTime() - 2 * 60 * 1000);
  const closeTime = new Date(nextEntry.getTime() + 15 * 60 * 1000);

  return { signalTime, entryTime: nextEntry, closeTime };
}

// Deriv API connector
async function getMarketSignal(pair) {
  const response = await fetch("https://api.deriv.com/api/v2/ticks_history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ticks_history: pair,
      granularity: 900, // 15 minutes
      count: 3,
      style: "candles",
    }),
  });
  const data = await response.json();
  if (!data.candles || data.candles.length < 2) {
    return "NoData";
  }
  const candles = data.candles;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return last.close > prev.close ? "Rise" : "Fall";
}

// Telegram sender
async function sendSignal(pair, direction, entry, close) {
  const message = `🔔 Signal Alert\nPair: ${pair}\nDirection: ${direction}\nEntry: ${entry}\nClose: ${close}\nNigeria Time 🇳🇬`;
  await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message }),
  });
}

// Cloudflare Worker entry
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const { entryTime, closeTime } = getNextCycleTimes();

      for (const pair of CONFIG.PAIRS) {
        const direction = await getMarketSignal(pair);
        await sendSignal(
          pair,
          direction,
          entryTime.toLocaleTimeString("en-NG"),
          closeTime.toLocaleTimeString("en-NG")
        );
      }

      return new Response("Signals sent successfully!");
    }
    return new Response("Use /trigger to send signals.");
  },
};



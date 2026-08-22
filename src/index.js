// src/index.js

function getNextCycleTimes() {
  const now = new Date();
  const nigeriaOffset = 1 * 60 * 60 * 1000; // UTC+1
  const localNow = new Date(now.getTime() + nigeriaOffset);

  const nextEntry = new Date(Math.ceil(localNow.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000));
  const signalTime = new Date(nextEntry.getTime() - 2 * 60 * 1000);
  const closeTime = new Date(nextEntry.getTime() + 15 * 60 * 1000);

  return { signalTime, entryTime: nextEntry, closeTime };
}

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

async function sendSignal(env, pair, direction, entry, close) {
  const message = `🔔 Signal Alert\nPair: ${pair}\nDirection: ${direction}\nEntry: ${entry}\nClose: ${close}\nNigeria Time 🇳🇬`;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      const { entryTime, closeTime } = getNextCycleTimes();
      const pairs = ["frxEURUSD", "frxGBPUSD", "frxUSDJPY"];

      for (const pair of pairs) {
        const direction = await getMarketSignal(pair);
        await sendSignal(
          env,
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


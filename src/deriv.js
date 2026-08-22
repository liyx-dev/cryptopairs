export async function getMarketSignal(pair) {
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

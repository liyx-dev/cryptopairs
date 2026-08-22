import { CONFIG } from "./config.js";

export async function sendSignal(pair, direction, entry, close) {
  const message = `🔔 Signal Alert\nPair: ${pair}\nDirection: ${direction}\nEntry: ${entry}\nClose: ${close}\nNigeria Time 🇳🇬`;
  await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message }),
  });
}


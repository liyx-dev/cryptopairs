import { CONFIG } from "./config.js";

export function getNextCycleTimes() {
  const now = new Date();
  const nigeriaOffset = CONFIG.TIMEZONE_OFFSET * 60 * 60 * 1000;
  const localNow = new Date(now.getTime() + nigeriaOffset);

  const nextEntry = new Date(Math.ceil(localNow.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000));
  const signalTime = new Date(nextEntry.getTime() - 2 * 60 * 1000);
  const closeTime = new Date(nextEntry.getTime() + 15 * 60 * 1000);

  return { signalTime, entryTime: nextEntry, closeTime };
}





// src/index.js

// Configuration
const CONFIG = {
  DERIV_TOKEN: "pat_bcc7e10e3436a29fde76b8eaa607a932251a0d84c28ed775a705c76e38702aa2",
  TELEGRAM_BOT_TOKEN: "8862813101:AAFfouRH6gmGVcPBrX8yyZxOFk6VPwjqJwg",
  TELEGRAM_CHAT_ID: "8737403387",
  TIMEZONE_OFFSET: 1, // Nigeria UTC+1
  PAIRS: ["frxEURUSD", "frxGBPUSD", "frxUSDJPY"], // add more pairs here
};

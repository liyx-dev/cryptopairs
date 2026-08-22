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

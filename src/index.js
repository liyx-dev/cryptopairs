import { CONFIG } from "./config.js";
import { getNextCycleTimes } from "./utils.js";
import { getMarketSignal } from "./deriv.js";
import { sendSignal } from "./telegram.js";

export default {
  async fetch(request, env) {
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

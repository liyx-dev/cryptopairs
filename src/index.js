// src/index.js

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      return new Response("✅ Trigger endpoint working!");
    }

    return new Response("Hello from Cloudflare Worker!");
  },
};

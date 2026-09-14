export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve a generated site if someone visits /site/xxxxx
    const siteMatch = url.pathname.match(/^\/site\/([a-zA-Z0-9]+)$/);
    if (siteMatch && request.method === "GET") {
      const siteId = siteMatch[1];
      const html = await env.SITES.get(siteId);
      if (html) {
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response("Site not found", { status: 404 });
    }

    // Telegram webhook
    if (request.method !== "POST") {
      return new Response("Bot is running.", { status: 200 });
    }

    try {
      const update = await request.json();

      if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const userText = update.message.text;

        if (userText === "/start") {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "👋 Welcome! I build websites for you.\n\n" +
            "Just tell me what kind of website you want. For example:\n" +
            "\"A bakery website with a menu and contact form\"\n\n" +
            "I'll generate it and give you a live link."
          );
          return new Response("OK", { status: 200 });
        }

        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "⏳ Generating your website... this takes about 30 seconds."
        );

        const websiteCode = await generateWebsite(userText, env.GEMINI_API_KEY);

        if (websiteCode.startsWith("Sorry")) {
          await sendMessage(env.TELEGRAM_TOKEN, chatId, websiteCode);
          return new Response("OK", { status: 200 });
        }

        // Save to KV and generate link
        const siteId = generateId();
        await env.SITES.put(siteId, websiteCode);

        const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
        const liveUrl = `${baseUrl}/site/${siteId}`;

        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "✅ Your website is live!\n\n" +
          "🔗 " + liveUrl + "\n\n" +
          "Open the link to see it."
        );
      }

      return new Response("OK", { status: 200 });

    } catch (error) {
      console.error("Error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    })
  });
}

async function generateWebsite(userPrompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const systemPrompt = `You are a website generator. The user will describe a website they want.
Return ONLY the complete HTML file with inline CSS and JavaScript. No explanations, no markdown, no code fences, just the raw HTML code starting with <!DOCTYPE html>.
Make it modern, responsive, and beautiful.`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: systemPrompt + "\n\nUser request: " + userPrompt
        }]
      }],
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    })
  });

  const data = await response.json();

  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    let code = data.candidates[0].content.parts[0].text;
    code = code.replace(/```html\n?/g, "").replace(/```\n?/g, "").trim();
    return code;
  }

  return "Sorry, I couldn't generate the website. Error: " + JSON.stringify(data).substring(0, 200);
    }

export default {
  async fetch(request, env, ctx) {
    // Only accept POST requests from Telegram
    if (request.method !== "POST") {
      return new Response("Bot is running.", { status: 200 });
    }

    try {
      const update = await request.json();

      // Handle regular messages
      if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const userText = update.message.text;

        // Handle /start command
        if (userText === "/start") {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "👋 Welcome! I build websites for you.\n\n" +
            "Just tell me what kind of website you want. For example:\n" +
            "\"A bakery website with a menu and contact form\"\n\n" +
            "I'll generate it and give you a live preview link."
          );
          return new Response("OK", { status: 200 });
        }

        // Send a "working on it" message
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "⏳ Generating your website... this takes about 30 seconds."
        );

        // Call Gemini to generate the website
        const websiteCode = await generateWebsite(userText, env.GEMINI_API_KEY);

        // For now, just send the code back (deployment comes next)
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "✅ Here's your website code:\n\n" +
          "```html\n" + websiteCode.substring(0, 3000) + "\n```\n\n" +
          "(Preview link coming soon)"
        );
      }

      return new Response("OK", { status: 200 });

    } catch (error) {
      console.error("Error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

// Send a message via Telegram Bot API
async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    })
  });
}

// Call Gemini API to generate website HTML
async function generateWebsite(userPrompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const systemPrompt = `You are a website generator. The user will describe a website they want.
Return ONLY the complete HTML file with inline CSS and JavaScript. No explanations, no markdown, just the raw HTML code.
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
    return data.candidates[0].content.parts[0].text;
  }

  // Log the full error so we can debug
  console.error("Gemini API error:", JSON.stringify(data));
  return "Sorry, I couldn't generate the website. Error: " + JSON.stringify(data).substring(0, 200);
                            }

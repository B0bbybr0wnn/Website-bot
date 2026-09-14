export default {
  async fetch(request, env, ctx) {
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

        const deployUrl = await deployToPages(
          websiteCode,
          env.CLOUDFLARE_API_TOKEN,
          env.CLOUDFLARE_ACCOUNT_ID
        );

        if (deployUrl) {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "✅ Your website is live!\n\n" +
            "🔗 " + deployUrl + "\n\n" +
            "Open the link to see it."
          );
        } else {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "❌ Website generated but deployment failed. Please try again."
          );
        }
      }

      return new Response("OK", { status: 200 });

    } catch (error) {
      console.error("Error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

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

async function deployToPages(htmlContent, apiToken, accountId) {
  try {
    const projectName = "user-sites";
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`;

    // Build multipart form data
    const formData = new FormData();
    formData.append("branch", "main");

    // Create the HTML file blob
    const htmlBlob = new Blob([htmlContent], { type: "text/html" });
    formData.append("file", htmlBlob, "index.html");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`
      },
      body: formData
    });

    const data = await response.json();

    if (data.success && data.result) {
      // Return the deployment URL or the project subdomain
      if (data.result.url) {
        return data.result.url;
      }
      if (data.result.aliases && data.result.aliases.length > 0) {
        return "https://" + data.result.aliases[0];
      }
      return `https://${projectName}.pages.dev`;
    }

    console.error("Pages deploy error:", JSON.stringify(data));
    return null;

  } catch (error) {
    console.error("Deploy error:", error);
    return null;
  }
        }

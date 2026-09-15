export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Paystack webhook
    if (url.pathname === "/webhook/paystack" && request.method === "POST") {
      return await handlePaystackWebhook(request, env);
    }

    // Serve a site
    const siteMatch = url.pathname.match(/^\/site\/([a-zA-Z0-9]+)$/);
    if (siteMatch && request.method === "GET") {
      const siteId = siteMatch[1];
      const data = await env.SITES.get(siteId, "json");
      if (!data) return new Response("Site not found", { status: 404 });

      let html = data.html;
      if (!data.paid) {
        // Inject a preview banner for unpaid sites
        const banner = `<div style="position:fixed;top:0;left:0;right:0;background:#ff6b00;color:white;padding:12px;text-align:center;font-family:sans-serif;font-weight:bold;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.2);">PREVIEW MODE — Pay to unlock your full website</div><div style="height:50px;"></div>`;
        html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      }

      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
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
            "👋 Welcome to *WebPanda*!\n\n" +
            "I build professional websites for you in seconds.\n\n" +
            "Choose your plan:\n\n" +
            "🟢 *Starter* — ₦50,000\n" +
            "One-page landing site with basic features.\n\n" +
            "🔵 *Business* — ₦85,000\n" +
            "3-5 pages, contact forms, basic SEO.\n\n" +
            "🟣 *Complex* — ₦180,000\n" +
            "E-commerce, booking, blog, custom domain.\n\n" +
            "Reply with *starter*, *business*, or *complex* to continue.\n\n" +
            "📜 [Terms and Conditions](https://github.com/B0bbybr0wnn/Website-bot/blob/main/terms.md)"
          );
          return new Response("OK", { status: 200 });
        }

        // Detect tier
        const lower = userText.toLowerCase();
        let tier = null;
        let price = 0;
        if (lower.includes("starter")) { tier = "Starter"; price = 50000; }
        else if (lower.includes("business")) { tier = "Business"; price = 85000; }
        else if (lower.includes("complex")) { tier = "Complex"; price = 180000; }

        // If user picked a tier, wait for description
        if (tier) {
          await env.SITES.put(`tier_${chatId}`, JSON.stringify({ tier, price }));
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            `✅ *${tier} plan* selected — ₦${price.toLocaleString()}\n\n` +
            "Now describe your website. For example:\n" +
            "\"A bakery website with a menu and contact form\""
          );
          return new Response("OK", { status: 200 });
        }

        // Check if user has a tier selected
        const tierData = await env.SITES.get(`tier_${chatId}`, "json");
        if (!tierData) {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "Please pick a plan first: *starter*, *business*, or *complex*."
          );
          return new Response("OK", { status: 200 });
        }

        // Generate the website
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "⏳ Generating your website... this takes about 30 seconds."
        );

        const websiteCode = await generateWebsite(userText, tierData.tier, env.GEMINI_API_KEY);

        if (websiteCode.startsWith("Sorry")) {
          await sendMessage(env.TELEGRAM_TOKEN, chatId, websiteCode);
          return new Response("OK", { status: 200 });
        }

        // Save site as unpaid
        const siteId = generateId();
        await env.SITES.put(siteId, JSON.stringify({
          html: websiteCode,
          paid: false,
          chatId: chatId,
          tier: tierData.tier,
          price: tierData.price
        }));

        const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
        const previewUrl = `${baseUrl}/site/${siteId}`;

        // Initialize Paystack transaction
        const paystackData = await initPaystack(
          chatId,
          tierData.price,
          env.PAYSTACK_SECRET_KEY,
          previewUrl
        );

        if (!paystackData || !paystackData.authorization_url) {
          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            "❌ Payment setup failed. Please try again."
          );
          return new Response("OK", { status: 200 });
        }

        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          `✅ *Preview ready!*\n\n` +
          `🔗 ${previewUrl}\n\n` +
          `_This is a preview with a watermark._\n\n` +
          `💳 To unlock your full website, pay *₦${tierData.price.toLocaleString()}*:\n` +
          `${paystackData.authorization_url}\n\n` +
          `Once payment is confirmed, your site will be unlocked automatically.`
        );

        // Clear the tier so user can order another site later
        await env.SITES.delete(`tier_${chatId}`);
      }

      return new Response("OK", { status: 200 });

    } catch (error) {
      console.error("Error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

// Handle Paystack webhook
async function handlePaystackWebhook(request, env) {
  try {
    const body = await request.json();

    // Verify signature
    const crypto = await import("crypto");
    const hash = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(body))
      .digest("hex");

    const signature = request.headers.get("x-paystack-signature");
    if (hash !== signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Handle successful charge
    if (body.event === "charge.success") {
      const metadata = body.data.metadata;
      const siteId = metadata && metadata.siteId;
      const chatId = metadata && metadata.chatId;

      if (siteId) {
        const data = await env.SITES.get(siteId, "json");
        if (data) {
          data.paid = true;
          await env.SITES.put(siteId, JSON.stringify(data));

          const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
          const liveUrl = `${baseUrl}/site/${siteId}`;

          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            `🎉 *Payment confirmed!*\n\n` +
            `Your website is now live:\n` +
            `🔗 ${liveUrl}\n\n` +
            `Thank you for using WebPanda!`
          );
        }
      }
    }

    return new Response("OK", { status: 200 });

  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Error", { status: 500 });
  }
}

// Initialize Paystack transaction
async function initPaystack(chatId, amount, secretKey, siteUrl) {
  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: `user${chatId}@webpanda.app`,
        amount: amount * 100, // Paystack uses kobo
        currency: "NGN",
        callback_url: siteUrl,
        metadata: {
          chatId: chatId,
          siteId: siteUrl.split("/site/")[1]
        }
      })
    });

    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error("Paystack init error:", error);
    return null;
  }
}

// Generate unique site ID
function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Send Telegram message
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

// Generate website with Gemini
async function generateWebsite(userPrompt, tier, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const tierInstructions = {
    "Starter": "Create a single-page landing site with hero, features, and contact section.",
    "Business": "Create a 3-5 page site with navigation (home, about, services, contact), contact form, and basic SEO meta tags.",
    "Complex": "Create a multi-page site with advanced features like booking forms, product listings, blog section, or e-commerce elements."
  };

  const systemPrompt = `You are a professional website generator. The user will describe a website they want. Generate a ${tier} tier website: ${tierInstructions[tier]}
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

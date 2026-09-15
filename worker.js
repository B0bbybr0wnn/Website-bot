export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/paystack" && request.method === "POST") {
      return await handlePaystackWebhook(request, env);
    }

    const siteMatch = url.pathname.match(/^\/site\/([a-zA-Z0-9]+)$/);
    if (siteMatch && request.method === "GET") {
      const siteId = siteMatch[1];
      const data = await env.SITES.get(siteId, "json");
      if (!data) return new Response("Site not found", { status: 404 });

      let html = data.html;
      if (!data.paid) {
        const banner = `<div style="position:fixed;top:0;left:0;right:0;background:#ff6b00;color:white;padding:12px;text-align:center;font-family:sans-serif;font-weight:bold;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.2);">PREVIEW MODE — Pay to unlock your full website</div><div style="height:50px;"></div>`;
        html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
      }

      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Bot is running.", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("OK", { status: 200 });
    }

    await handleUpdate(update, env);
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPendingJobs(env));
  }
};

async function handleUpdate(update, env) {
  try {
    if (!update.message || !update.message.text) return;

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
      return;
    }

    // Check if user has an active site (tweak mode)
    const userSite = await env.SITES.get(`user_${chatId}`, "json");

    if (userSite && userSite.siteId) {
      // User has a site — treat this message as a tweak request
      await handleTweakRequest(chatId, userText, userSite, env);
      return;
    }

    // Otherwise, normal tier flow
    const lower = userText.toLowerCase();
    let tier = null;
    let price = 0;
    if (lower.includes("starter")) { tier = "Starter"; price = 50000; }
    else if (lower.includes("business")) { tier = "Business"; price = 85000; }
    else if (lower.includes("complex")) { tier = "Complex"; price = 180000; }

    if (tier) {
      await env.SITES.put(`tier_${chatId}`, JSON.stringify({ tier, price }));
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `✅ *${tier} plan* selected — ₦${price.toLocaleString()}\n\n` +
        "Now describe your website. For example:\n" +
        "\"A bakery website with a menu and contact form\""
      );
      return;
    }

    const tierData = await env.SITES.get(`tier_${chatId}`, "json");
    if (!tierData) {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        "Please pick a plan first: *starter*, *business*, or *complex*."
      );
      return;
    }

    const jobId = generateId();
    await env.SITES.put(`job_${jobId}`, JSON.stringify({
      jobId: jobId,
      chatId: chatId,
      userText: userText,
      tier: tierData.tier,
      price: tierData.price,
      status: "pending",
      createdAt: Date.now()
    }));

    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "⏳ Generating your website... this takes up to 1 minute."
    );

    await env.SITES.delete(`tier_${chatId}`);

  } catch (error) {
    console.error("handleUpdate error:", error.message, error.stack);
  }
}

async function handleTweakRequest(chatId, userText, userSite, env) {
  try {
    const { siteId, tweaksUsed, tweaksLimit } = userSite;

    // Check if they've used all their tweaks
    if (tweaksUsed >= tweaksLimit) {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🔒 *You've used all your free edits.*\n\n` +
        `You've used ${tweaksUsed} edits on this site.\n\n` +
        `Want more? Pay *₦3,000* to unlock *5 more edits*.\n\n` +
        `Reply */pay_tweak* to continue.`
      );
      return;
    }

    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "⏳ Applying your changes... this takes up to 1 minute."
    );

    // Save tweak job
    const jobId = generateId();
    await env.SITES.put(`job_${jobId}`, JSON.stringify({
      jobId: jobId,
      chatId: chatId,
      userText: userText,
      siteId: siteId,
      isTweak: true,
      status: "pending",
      createdAt: Date.now()
    }));

  } catch (error) {
    console.error("handleTweakRequest error:", error.message, error.stack);
  }
}

async function processPendingJobs(env) {
  try {
    const list = await env.SITES.list({ prefix: "job_" });

    for (const key of list.keys) {
      const job = await env.SITES.get(key.name, "json");
      if (!job || job.status !== "pending") continue;

      job.status = "processing";
      await env.SITES.put(key.name, JSON.stringify(job));

      try {
        if (job.isTweak) {
          await processTweakJob(job, key.name, env);
        } else {
          await processNewSiteJob(job, key.name, env);
        }
      } catch (err) {
        console.error("Job process error:", err.message);
        job.status = "pending";
        await env.SITES.put(key.name, JSON.stringify(job));
      }
    }
  } catch (err) {
    console.error("processPendingJobs error:", err.message);
  }
}

async function processNewSiteJob(job, jobKey, env) {
  const websiteCode = await generateWebsite(job.userText, job.tier, env.GEMINI_API_KEY);

  if (websiteCode.startsWith("⏳")) {
    job.status = "pending";
    await env.SITES.put(jobKey, JSON.stringify(job));
    return;
  }

  const siteId = generateId();
  await env.SITES.put(siteId, JSON.stringify({
    html: websiteCode,
    paid: false,
    chatId: job.chatId,
    tier: job.tier,
    price: job.price
  }));

  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  const previewUrl = `${baseUrl}/site/${siteId}`;

  const paystackData = await initPaystack(job.chatId, job.price, env.PAYSTACK_SECRET_KEY, siteId);

  if (!paystackData || !paystackData.authorization_url) {
    await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
      "❌ Payment setup failed. Please try again."
    );
    await env.SITES.delete(jobKey);
    return;
  }

  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ *Preview ready!*\n\n` +
    `🔗 ${previewUrl}\n\n` +
    `_This is a preview with a watermark._\n\n` +
    `💳 To unlock your full website, pay *₦${job.price.toLocaleString()}*:\n` +
    `${paystackData.authorization_url}\n\n` +
    `Once payment is confirmed, your site will be unlocked automatically.`
  );

  await env.SITES.delete(jobKey);
}

async function processTweakJob(job, jobKey, env) {
  const siteData = await env.SITES.get(job.siteId, "json");
  if (!siteData) {
    await env.SITES.delete(jobKey);
    return;
  }

  const updatedHtml = await generateTweak(siteData.html, job.userText, env.GEMINI_API_KEY);

  if (!updatedHtml || updatedHtml.startsWith("⏳")) {
    job.status = "pending";
    await env.SITES.put(jobKey, JSON.stringify(job));
    return;
  }

  siteData.html = updatedHtml;
  await env.SITES.put(job.siteId, JSON.stringify(siteData));

  // Increment tweaks used
  const userSite = await env.SITES.get(`user_${job.chatId}`, "json");
  if (userSite) {
    userSite.tweaksUsed = (userSite.tweaksUsed || 0) + 1;
    await env.SITES.put(`user_${job.chatId}`, JSON.stringify(userSite));
  }

  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  const liveUrl = `${baseUrl}/site/${job.siteId}`;

  const remaining = userSite ? (userSite.tweaksLimit - userSite.tweaksUsed) : 0;

  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ *Changes applied!*\n\n` +
    `🔗 ${liveUrl}\n\n` +
    `_You have ${remaining} free edit${remaining === 1 ? "" : "s"} remaining._`
  );

  await env.SITES.delete(jobKey);
}

async function handlePaystackWebhook(request, env) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);

    const encoder = new TextEncoder();
    const keyData = encoder.encode(env.PAYSTACK_SECRET_KEY);
    const messageData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    const signature = request.headers.get("x-paystack-signature");
    if (hash !== signature) {
      console.error("Invalid webhook signature");
      return new Response("Invalid signature", { status: 401 });
    }

    if (body.event === "charge.success") {
      const metadata = body.data.metadata || {};
      const chatId = metadata.chatId;
      const siteId = metadata.siteId;
      const type = metadata.type;

      if (!chatId) {
        return new Response("OK", { status: 200 });
      }

      // Handle tweak payment
      if (type === "tweak") {
        const userSite = await env.SITES.get(`user_${chatId}`, "json");
        if (userSite) {
          userSite.tweaksLimit = (userSite.tweaksLimit || 3) + 5;
          await env.SITES.put(`user_${chatId}`, JSON.stringify(userSite));

          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            `🎉 *Payment confirmed!*\n\n` +
            `You now have *5 more edits* unlocked.\n\n` +
            `Just send your changes and I'll apply them.`
          );
        }
        return new Response("OK", { status: 200 });
      }

      // Handle site payment
      if (siteId) {
        const data = await env.SITES.get(siteId, "json");
        if (data) {
          data.paid = true;
          await env.SITES.put(siteId, JSON.stringify(data));

          // Register this user for tweaks
          await env.SITES.put(`user_${chatId}`, JSON.stringify({
            siteId: siteId,
            tweaksUsed: 0,
            tweaksLimit: 3
          }));

          const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
          const liveUrl = `${baseUrl}/site/${siteId}`;

          await sendMessage(env.TELEGRAM_TOKEN, chatId,
            `🎉 *Payment confirmed!*\n\n` +
            `Your website is now live:\n` +
            `🔗 ${liveUrl}\n\n` +
            `*You have 3 free edits.* Just describe any changes you want — colors, text, phone number, anything.\n\n` +
            `Thank you for using WebPanda!`
          );
        }
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error.message, error.stack);
    return new Response("Error", { status: 500 });
  }
}

async function initPaystack(chatId, amount, secretKey, siteId, type) {
  try {
    const metadata = { chatId: chatId };
    if (type === "tweak") {
      metadata.type = "tweak";
    } else {
      metadata.siteId = siteId;
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: `user${chatId}@webpanda.app`,
        amount: amount * 100,
        currency: "NGN",
        metadata: metadata
      })
    });

    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error("Paystack init error:", error.message);
    return null;
  }
}

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

  return await callGemini(url, systemPrompt + "\n\nUser request: " + userPrompt);
}

async function generateTweak(currentHtml, tweakRequest, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const prompt = `Here is an existing website HTML. The user wants these changes applied:

USER REQUEST: ${tweakRequest}

Apply ONLY the requested changes. Keep everything else the same.
Return ONLY the complete updated HTML file. No explanations, no markdown, no code fences.

CURRENT HTML:
${currentHtml}`;

  return await callGemini(url, prompt);
}

async function callGemini(url, prompt) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
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

      if (data.error && (data.error.code === 503 || data.error.code === 500)) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      break;
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
  }
  return "⏳ *WebPanda is busy right now.* Please try again in a minute.";
        }

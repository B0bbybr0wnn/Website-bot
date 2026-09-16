export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/paystack" && request.method === "POST") {
      return await handlePaystackWebhook(request, env);
    }

    const blogMatch = url.pathname.match(/^\/blog\/([a-zA-Z0-9]+)$/);
    if (blogMatch && request.method === "GET") {
      return await handleBlogPage(blogMatch[1], env);
    }

    const siteMatch = url.pathname.match(/^\/site\/([a-zA-Z0-9]+)$/);
    if (siteMatch && request.method === "GET") {
      const siteId = siteMatch[1];
      const data = await env.SITES.get(`site_${siteId}`, "json");
      if (!data) return new Response("Site not found", { status: 404 });

      let html = data.html;
      if (!data.paid) {
        const banner = `<div style="position:fixed;top:0;left:0;right:0;background:#ff6b00;color:white;padding:10px;text-align:center;font-family:sans-serif;font-weight:bold;font-size:14px;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,0.2);">🔒 PREVIEW MODE — Pay to unlock your full website</div><div style="position:fixed;bottom:0;left:0;right:0;background:#ff6b00;color:white;padding:10px;text-align:center;font-family:sans-serif;font-weight:bold;font-size:14px;z-index:99999;box-shadow:0 -2px 8px rgba(0,0,0,0.2);">🔒 PREVIEW MODE — Pay to unlock your full website</div>`;
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

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const job = message.body;

        if (job.isTweak) {
          await processTweakJob(job, env);
        } else {
          await processNewSiteJob(job, env);
        }

        message.ack();
      } catch (err) {
        console.error("Queue job error:", err.message);
        message.retry();
      }
    }
  }
};

async function handleUpdate(update, env) {
  try {
    if (!update.message || !update.message.text) return;

    const chatId = update.message.chat.id;
    const userText = update.message.text;
    const lower = userText.toLowerCase().trim();

    if (userText === "/start") {
      await sendStartMessage(chatId, env);
      return;
    }

    if (userText === "/support") {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `💬 *Need help?*\n\n` +
        `Message me directly and I'll sort it out:\n` +
        `👉 [Chat with support](https://t.me/B0bb_y)\n\n` +
        `Common issues I can help with:\n` +
        `• Payment didn't work\n` +
        `• Site not loading\n` +
        `• Custom domain setup\n` +
        `• Refunds\n` +
        `• Anything else`
      );
      return;
    }

    if (userText === "/domain") {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🌐 *Custom Domain*\n\n` +
        `Want your own professional web address instead of the long link?\n\n` +
        `Use /buydomain to check availability and order.\n\n` +
        `Pricing:\n` +
        `• Global (.com, .net, .org, .io, .dev) — ₦20,000/year\n` +
        `• Nigerian (.com.ng) — ₦25,000/year\n\n` +
        `💬 Need help? Reply /support`
      );
      return;
    }

    if (userText === "/buydomain") {
      await env.SITES.put(`domainmode_${chatId}`, "awaiting_name");
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🌐 *Domain Search*\n\n` +
        `Send me the name you want (without extension).\n\n` +
        `Example: \`mybakery\`\n\n` +
        `I'll check these extensions:\n` +
        `.com · .net · .org · .io · .dev · .com.ng\n\n` +
        `_Reply /cancel to stop._`
      );
      return;
    }

    if (userText.startsWith("/pickdomain ")) {
      const domain = userText.substring(12).trim().toLowerCase();
      await handlePickDomain(chatId, domain, env);
      return;
    }

    // Check if user is in domain name entry mode
    const domainMode = await env.SITES.get(`domainmode_${chatId}`);
    if (domainMode === "awaiting_name") {
      await handleDomainSearch(chatId, userText, env);
      return;
    }

    if (userText === "/newsite") {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `➕ *New Website*\n\n` +
        `Choose your plan:\n\n` +
        `🟢 *Starter* — ₦50,000\n` +
        `One-page landing site.\n\n` +
        `🔵 *Business* — ₦85,000\n` +
        `3-5 pages, contact forms, basic SEO.\n\n` +
        `🟣 *Complex* — ₦180,000\n` +
        `E-commerce, booking, blog, custom domain.\n\n` +
        `Reply with *starter*, *business*, or *complex*.\n\n` +
        `_Changed your mind? Reply /cancel_`
      );
      return;
    }

    if (userText === "/mysites") {
      await handleMySites(chatId, env);
      return;
    }

    if (userText.startsWith("/switch")) {
      const parts = userText.split(" ");
      const index = parts[1];
      if (!index) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          `Usage: /switch 1\n\nUse /mysites to see your site list.`
        );
        return;
      }
      await handleSwitch(chatId, parseInt(index), env);
      return;
    }

    if (userText.startsWith("/delete")) {
      const parts = userText.split(" ");
      const index = parts[1];
      if (!index) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          `Usage: /delete 1\n\nUse /mysites to see your site list.`
        );
        return;
      }
      await handleDelete(chatId, parseInt(index), env);
      return;
    }

    if (userText === "/cancel") {
      await env.SITES.delete(`domainmode_${chatId}`);
      await handleCancel(chatId, env);
      return;
    }

    if (userText === "/pay_tweak") {
      await handlePayTweak(chatId, env);
      return;
    }

    if (userText === "/addpost") {
      const activeId = await env.SITES.get(`active_${chatId}`);
      if (!activeId) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "You need a live website with a blog first.\n\n" +
          "Build one with /newsite and describe it as a blog or news site."
        );
        return;
      }
      const siteData = await env.SITES.get(`site_${activeId}`, "json");
      if (!siteData || !siteData.html.includes("/blog/")) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          "Your active site doesn't have a blog section.\n\n" +
          "You can add one by requesting a tweak — just describe what you want.\n" +
          "Or contact /support for help."
        );
        return;
      }
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `📝 *Add a blog post*\n\n` +
        `Format:\n` +
        `/addpost Title | Body text\n\n` +
        `Example:\n` +
        `/addpost My First Post | This is what I learned today...`
      );
      return;
    }

    if (userText.startsWith("/addpost ")) {
      await handleAddPost(chatId, userText.substring(9).trim(), env);
      return;
    }

    if (userText === "/listposts") {
      await handleListPosts(chatId, env);
      return;
    }

    if (userText.startsWith("/deletepost ")) {
      const num = userText.substring(12).trim();
      await handleDeletePost(chatId, parseInt(num), env);
      return;
    }

    let tier = null;
    let price = 0;
    if (lower === "starter" || lower.includes("starter")) { tier = "Starter"; price = 50000; }
    else if (lower === "business" || lower.includes("business")) { tier = "Business"; price = 85000; }
    else if (lower === "complex" || lower.includes("complex")) { tier = "Complex"; price = 180000; }

    if (tier) {
      await env.SITES.put(`tier_${chatId}`, JSON.stringify({ tier, price }));
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `✅ *${tier} plan* selected — ₦${price.toLocaleString()}\n\n` +
        "Now describe your website. For example:\n" +
        "\"A bakery website with a menu and contact form\"\n\n" +
        `_Changed your mind? Reply /cancel_`
      );
      return;
    }

    const tierData = await env.SITES.get(`tier_${chatId}`, "json");
    if (tierData) {
      const jobId = generateId();
      const job = {
        jobId: jobId,
        chatId: chatId,
        userText: userText,
        tier: tierData.tier,
        price: tierData.price,
        createdAt: Date.now()
      };

      await env.JOB_QUEUE.send(job);

      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        "⏳ Generating your website... this takes up to 3 minutes."
      );

      await env.SITES.delete(`tier_${chatId}`);
      return;
    }

    const activeId = await env.SITES.get(`active_${chatId}`);
    if (activeId) {
      const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
      const site = sites.find(s => s.siteId === activeId);
      if (site) {
        await handleTweakRequest(chatId, userText, site, env);
        return;
      }
    }

    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "Reply /start to see the menu.\n\n" +
      "💬 Need help? Reply /support"
    );

  } catch (error) {
    console.error("handleUpdate error:", error.message, error.stack);
  }
}

async function handleDomainSearch(chatId, rawName, env) {
  const name = rawName.toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (!name || name.length < 2) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "❌ That name doesn't look right. Send just the name, like: `mybakery`"
    );
    return;
  }

  await env.SITES.delete(`domainmode_${chatId}`);
  await sendMessage(env.TELEGRAM_TOKEN, chatId,
    `🔍 Checking availability for *${name}*...`
  );

  const extensions = [
    { ext: ".com", price: 20000, rdap: `https://rdap.org/domain/${name}.com` },
    { ext: ".net", price: 20000, rdap: `https://rdap.org/domain/${name}.net` },
    { ext: ".org", price: 20000, rdap: `https://rdap.org/domain/${name}.org` },
    { ext: ".io", price: 20000, rdap: `https://rdap.org/domain/${name}.io` },
    { ext: ".dev", price: 20000, rdap: `https://rdap.org/domain/${name}.dev` },
    { ext: ".com.ng", price: 25000, rdap: `https://rdap.nic.net.ng/domain/${name}.com.ng` }
  ];

  const results = await Promise.all(
    extensions.map(async (e) => {
      try {
        const res = await fetch(e.rdap, {
          method: "GET",
          headers: { "Accept": "application/rdap+json" }
        });
        return { ...e, available: res.status === 404 };
      } catch (err) {
        return { ...e, available: null };
      }
    })
  );

  let list = `🌐 *Domain Search: ${name}*\n\n`;
  let anyAvailable = false;

  results.forEach(r => {
    if (r.available === true) {
      list += `✅ *${name}${r.ext}* — Available (₦${r.price.toLocaleString()}/year)\n`;
      anyAvailable = true;
    } else if (r.available === false) {
      list += `❌ ${name}${r.ext} — Taken\n`;
    } else {
      list += `⚠️ ${name}${r.ext} — Check failed\n`;
    }
  });

  list += "\n";

  if (anyAvailable) {
    list += `*To order*, reply:\n\`/pickdomain ${name}.com\`\n(replace .com with the extension you want)`;
  } else {
    list += `No extensions available for *${name}*. Try a different name with /buydomain.`;
  }

  await sendMessage(env.TELEGRAM_TOKEN, chatId, list);
}

async function handlePickDomain(chatId, domain, env) {
  const validExts = [".com", ".net", ".org", ".io", ".dev", ".com.ng"];
  const ext = validExts.find(e => domain.endsWith(e));

  if (!ext) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "❌ Invalid extension. Use /buydomain to search first."
    );
    return;
  }

  const price = ext === ".com.ng" ? 25000 : 20000;

  const paystackData = await initPaystack(chatId, price, env.PAYSTACK_SECRET_KEY, null, "domain", domain);
  if (paystackData && paystackData.authorization_url) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      `💳 *Order Domain: ${domain}*\n\n` +
      `Amount: *₦${price.toLocaleString()}*\n\n` +
      `Pay here:\n${paystackData.authorization_url}\n\n` +
      `Once payment is confirmed, I'll register your domain and set it up. This usually takes 1-2 hours.\n\n` +
      `💬 Need help? Reply /support`
    );
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "❌ Payment setup failed. Reply /support if this keeps happening."
    );
  }
}

async function sendStartMessage(chatId, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  const paidSites = sites.filter(s => s.paid === true);

  let hasBlog = false;
  if (paidSites.length > 0) {
    const activeId = await env.SITES.get(`active_${chatId}`);
    if (activeId) {
      const siteData = await env.SITES.get(`site_${activeId}`, "json");
      if (siteData && siteData.html.includes("/blog/")) {
        hasBlog = true;
      }
    }
  }

  let menu = "👋 Welcome to *WebPanda*!\n\n";

  if (sites.length === 0) {
    menu += "I build professional websites for you in seconds.\n\n";
    menu += "*Get started:*\n";
    menu += "➕ /newsite — Build a website\n";
    menu += "🌐 /buydomain — Get a custom domain\n";
    menu += "💬 /support — Get help\n";
  } else if (paidSites.length === 0) {
    menu += "You have a preview waiting.\n\n";
    menu += "*Commands:*\n";
    menu += "➕ /newsite — Build a new website\n";
    menu += "🌐 /mysites — View your preview\n";
    menu += "🌐 /buydomain — Get a custom domain\n";
    menu += "💬 /support — Get help\n";
  } else {
    menu += "*Commands:*\n";
    menu += "➕ /newsite — Build a new website\n";
    menu += "🌐 /mysites — View and manage your websites\n";
    if (hasBlog) {
      menu += "📝 /addpost — Add a blog post\n";
      menu += "📋 /listposts — See your blog posts\n";
    }
    menu += "🌐 /buydomain — Get a custom domain\n";
    menu += "💬 /support — Get help\n";
  }

  menu += "\n📜 [Terms and Conditions](https://github.com/B0bbybr0wnn/Website-bot/blob/main/terms.md)";

  await sendMessage(env.TELEGRAM_TOKEN, chatId, menu);
}

async function handleAddPost(chatId, text, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "You need a live website with a blog first."
    );
    return;
  }

  const siteData = await env.SITES.get(`site_${activeId}`, "json");
  if (!siteData || !siteData.html.includes("/blog/")) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      "Your active site doesn't have a blog section."
    );
    return;
  }

  const parts = text.split("|");
  if (parts.length < 2) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      `❌ Format: /addpost Title | Body text`
    );
    return;
  }

  const title = parts[0].trim();
  const body = parts.slice(1).join("|").trim();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50);
  const createdAt = Date.now();

  try {
    await env.BLOG_DB.prepare(
      "INSERT INTO posts (site_id, title, slug, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(activeId, title, slug, body, createdAt).run();

    const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      `✅ *Post added!*\n\n📄 *${title}*\n\n🔗 ${baseUrl}/blog/${activeId}`
    );
  } catch (err) {
    console.error("Add post error:", err.message);
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed to add post. Reply /support.");
  }
}

async function handleListPosts(chatId, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "No active site.");
    return;
  }

  try {
    const result = await env.BLOG_DB.prepare(
      "SELECT id, title FROM posts WHERE site_id = ? ORDER BY created_at DESC"
    ).bind(activeId).all();

    if (!result.results || result.results.length === 0) {
      await sendMessage(env.TELEGRAM_TOKEN, chatId, "No blog posts yet. Add one with /addpost");
      return;
    }

    let list = "📋 *Your Blog Posts:*\n\n";
    result.results.forEach((p, i) => {
      list += `*${i + 1}.* ${p.title}\n   _ID: ${p.id}_\n\n`;
    });
    list += "To delete: `/deletepost ID`";

    await sendMessage(env.TELEGRAM_TOKEN, chatId, list);
  } catch (err) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed to load posts.");
  }
}

async function handleDeletePost(chatId, postId, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId || !postId || isNaN(postId)) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid. Use /listposts to see IDs.");
    return;
  }
  try {
    await env.BLOG_DB.prepare("DELETE FROM posts WHERE id = ? AND site_id = ?").bind(postId, activeId).run();
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `🗑️ Post deleted.`);
  } catch (err) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed to delete.");
  }
}

async function handleBlogPage(siteId, env) {
  try {
    const result = await env.BLOG_DB.prepare(
      "SELECT title, slug, body, created_at FROM posts WHERE site_id = ? ORDER BY created_at DESC"
    ).bind(siteId).all();

    const posts = result.results || [];

    let postsHtml = "";
    if (posts.length === 0) {
      postsHtml = `<p style="text-align:center;color:#888;padding:60px 20px;">No posts yet.</p>`;
    } else {
      postsHtml = posts.map(p => {
        const date = new Date(p.created_at).toLocaleDateString();
        return `<article style="margin-bottom:48px;padding-bottom:32px;border-bottom:1px solid #eee;">
          <h2 style="font-size:28px;margin:0 0 8px;color:#111;">${escapeHtml(p.title)}</h2>
          <p style="color:#888;font-size:13px;margin:0 0 16px;">${date}</p>
          <div style="color:#333;line-height:1.7;">${escapeHtml(p.body).replace(/\n/g, "<br>")}</div>
        </article>`;
      }).join("");
    }

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Blog</title>
<style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 40px 20px; background: #fff; color: #111; }
h1 { font-size: 36px; margin-bottom: 40px; border-bottom: 3px solid #ff6b00; padding-bottom: 12px; display: inline-block; }</style>
</head><body><h1>Blog</h1>${postsHtml}</body></html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  } catch (err) {
    return new Response("Blog error", { status: 500 });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function handleMySites(chatId, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (sites.length === 0) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "No websites yet. Reply /newsite to build one.");
    return;
  }

  const activeId = await env.SITES.get(`active_${chatId}`);
  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";

  let list = "🌐 *Your Websites:*\n\n";
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const isActive = s.siteId === activeId ? " ⬅️ active" : "";
    let status = s.paid
      ? `✅ Live — ${s.tweaksLimit - s.tweaksUsed} edit${(s.tweaksLimit - s.tweaksUsed) === 1 ? "" : "s"} remaining`
      : `⏳ Preview (unpaid)`;
    list += `*${i + 1}.* ${s.name} (${s.tier})${isActive}\n   ${status}\n   🔗 ${baseUrl}/site/${s.siteId}\n\n`;
  }
  list += "`/switch N` — Switch to site N\n`/delete N` — Delete site N";

  await sendMessage(env.TELEGRAM_TOKEN, chatId, list);
}

async function handleSwitch(chatId, index, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (index < 1 || index > sites.length) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid number. Use /mysites.");
    return;
  }
  const site = sites[index - 1];
  await env.SITES.put(`active_${chatId}`, site.siteId);
  await sendMessage(env.TELEGRAM_TOKEN, chatId,
    `✅ Now editing: *${site.name}*\n\nYou have ${site.tweaksLimit - site.tweaksUsed} edits remaining.`
  );
}

async function handleDelete(chatId, index, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (index < 1 || index > sites.length) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid number.");
    return;
  }
  const site = sites[index - 1];
  sites.splice(index - 1, 1);
  await env.SITES.put(`sites_${chatId}`, JSON.stringify(sites));
  await env.SITES.delete(`site_${site.siteId}`);
  try { await env.BLOG_DB.prepare("DELETE FROM posts WHERE site_id = ?").bind(site.siteId).run(); } catch (e) {}
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (activeId === site.siteId) await env.SITES.delete(`active_${chatId}`);
  await sendMessage(env.TELEGRAM_TOKEN, chatId, `🗑️ Deleted: *${site.name}*`);
}

async function handleCancel(chatId, env) {
  const tierData = await env.SITES.get(`tier_${chatId}`, "json");
  if (tierData) {
    await env.SITES.delete(`tier_${chatId}`);
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `✅ Cancelled.`);
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `Nothing to cancel.`);
  }
}

async function handlePayTweak(chatId, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "No active site.");
    return;
  }
  const paystackData = await initPaystack(chatId, 3000, env.PAYSTACK_SECRET_KEY, null, "tweak");
  if (paystackData && paystackData.authorization_url) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `💳 *Pay ₦3,000:*\n\n${paystackData.authorization_url}`);
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Payment setup failed.");
  }
}

async function handleTweakRequest(chatId, userText, site, env) {
  if (site.tweaksUsed >= site.tweaksLimit) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      `🔒 *You've used all edits.*\n\nPay *₦3,000* for *5 more*. Reply /pay_tweak`
    );
    return;
  }
  const job = { jobId: generateId(), chatId, userText, siteId: site.siteId, isTweak: true, createdAt: Date.now() };
  await env.JOB_QUEUE.send(job);
  await sendMessage(env.TELEGRAM_TOKEN, chatId, "⏳ Applying your changes... this takes up to 3 minutes.");
}

async function processNewSiteJob(job, env) {
  const websiteCode = await generateWebsite(job.userText, job.tier, env.GEMINI_API_KEY);
  if (websiteCode.startsWith("⏳")) throw new Error("Gemini busy");

  const siteId = generateId();
  const siteName = job.userText.substring(0, 30);
  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  const finalHtml = websiteCode.replace(/BLOG_URL_PLACEHOLDER/g, `${baseUrl}/blog/${siteId}`);

  await env.SITES.put(`site_${siteId}`, JSON.stringify({ html: finalHtml, paid: false }));

  const sites = await env.SITES.get(`sites_${job.chatId}`, "json") || [];
  sites.push({ siteId, tier: job.tier, price: job.price, name: siteName, tweaksUsed: 0, tweaksLimit: 0, paid: false, createdAt: Date.now() });
  await env.SITES.put(`sites_${job.chatId}`, JSON.stringify(sites));

  const previewUrl = `${baseUrl}/site/${siteId}`;
  const paystackData = await initPaystack(job.chatId, job.price, env.PAYSTACK_SECRET_KEY, siteId);

  if (!paystackData || !paystackData.authorization_url) {
    await sendMessage(env.TELEGRAM_TOKEN, job.chatId, "❌ Payment setup failed. Reply /support.");
    return;
  }

  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ *Preview ready!*\n\n🔗 ${previewUrl}\n\n_This is a preview with a watermark._\n\n💳 To unlock, pay *₦${job.price.toLocaleString()}*:\n${paystackData.authorization_url}\n\n📌 *After payment:*\n• Send your social media links and I'll add them\n• You'll have 3 free edits\n\n💬 Need help? Reply /support`
  );
}

async function processTweakJob(job, env) {
  const siteData = await env.SITES.get(`site_${job.siteId}`, "json");
  if (!siteData) throw new Error("Site not found");

  const updatedHtml = await generateTweak(siteData.html, job.userText, env.GEMINI_API_KEY);
  if (!updatedHtml || updatedHtml.startsWith("⏳")) throw new Error("Gemini busy");

  siteData.html = updatedHtml;
  await env.SITES.put(`site_${job.siteId}`, JSON.stringify(siteData));

  const sites = await env.SITES.get(`sites_${job.chatId}`, "json") || [];
  const site = sites.find(s => s.siteId === job.siteId);
  if (site) { site.tweaksUsed = (site.tweaksUsed || 0) + 1; await env.SITES.put(`sites_${job.chatId}`, JSON.stringify(sites)); }

  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ *Changes applied!*\n\n🔗 ${baseUrl}/site/${job.siteId}\n\n_You have ${site.tweaksLimit - site.tweaksUsed} edit${(site.tweaksLimit - site.tweaksUsed) === 1 ? "" : "s"} remaining._`
  );
}

async function handlePaystackWebhook(request, env) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);

    const encoder = new TextEncoder();
    const keyData = encoder.encode(env.PAYSTACK_SECRET_KEY);
    const messageData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    const signature = request.headers.get("x-paystack-signature");
    if (hash !== signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (body.event === "charge.success") {
      const metadata = body.data.metadata || {};
      const chatId = metadata.chatId;
      const siteId = metadata.siteId;
      const type = metadata.type;
      const domain = metadata.domain;

      if (!chatId) return new Response("OK", { status: 200 });

      if (type === "tweak") {
        const activeId = await env.SITES.get(`active_${chatId}`);
        if (activeId) {
          const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
          const site = sites.find(s => s.siteId === activeId);
          if (site) {
            site.tweaksLimit = (site.tweaksLimit || 0) + 5;
            await env.SITES.put(`sites_${chatId}`, JSON.stringify(sites));
          }
        }
        await sendMessage(env.TELEGRAM_TOKEN, chatId, `🎉 *Payment confirmed!*\n\nYou now have *5 more edits*.`);
        return new Response("OK", { status: 200 });
      }

      if (type === "domain" && domain) {
        // Notify admin (you)
        await sendMessage(env.TELEGRAM_TOKEN, "6778703420",
          `🔔 *NEW DOMAIN ORDER*\n\n` +
          `Domain: *${domain}*\n` +
          `Customer Chat ID: \`${chatId}\`\n\n` +
          `Go register this domain and connect it to their site.\n` +
          `Reply to customer via /support if needed.`
        );

        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          `🎉 *Payment confirmed!*\n\n` +
          `Your domain: *${domain}*\n\n` +
          `I'll register it and set it up for you. This takes 1-2 hours.\n` +
          `I'll message you when it's live.\n\n` +
          `💬 Need help? Reply /support`
        );
        return new Response("OK", { status: 200 });
      }

      if (siteId) {
        const siteData = await env.SITES.get(`site_${siteId}`, "json");
        if (siteData) {
          siteData.paid = true;
          await env.SITES.put(`site_${siteId}`, JSON.stringify(siteData));
        }

        const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
        const site = sites.find(s => s.siteId === siteId);
        if (site) {
          site.paid = true;
          site.tweaksUsed = 0;
          site.tweaksLimit = 3;
          await env.SITES.put(`sites_${chatId}`, JSON.stringify(sites));
          await env.SITES.put(`active_${chatId}`, siteId);
        }

        const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
        const hasBlog = siteData && siteData.html.includes("/blog/");
        let msg = `🎉 *Payment confirmed!*\n\nYour website is live:\n🔗 ${baseUrl}/site/${siteId}\n\n`;
        if (hasBlog) msg += `📝 Blog: ${baseUrl}/blog/${siteId}\n\n`;
        msg += `*To personalize:*\n• Send your social media links\n`;
        if (hasBlog) msg += `• Add posts with /addpost\n`;
        msg += `• You have 3 free edits\n\n🌐 Want a custom domain? Reply /buydomain\n\n💬 /support`;

        await sendMessage(env.TELEGRAM_TOKEN, chatId, msg);
      }
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return new Response("Error", { status: 500 });
  }
}

async function initPaystack(chatId, amount, secretKey, siteId, type, domain) {
  try {
    const metadata = { chatId };
    if (type === "tweak") metadata.type = "tweak";
    else if (type === "domain") { metadata.type = "domain"; metadata.domain = domain; }
    else metadata.siteId = siteId;

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { "Authorization": `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `user${chatId}@webpanda.app`,
        amount: amount * 100,
        currency: "NGN",
        metadata
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
  for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true })
  });
}

async function generateWebsite(userPrompt, tier, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const tierInstructions = {
    "Starter": "Create a single-page landing site with hero, features, and contact section.",
    "Business": "Create a 3-5 page site with navigation, contact form, and basic SEO meta tags.",
    "Complex": "Create a multi-page site with advanced features like booking forms, product listings, or e-commerce elements."
  };

  const systemPrompt = `You are a professional website generator. Generate a ${tier} tier website: ${tierInstructions[tier]}

SMART BLOG DETECTION:
If the user's request mentions: blog, news, articles, posts, updates, magazine, journal, press
→ Include a navigation link with text "Blog" and href="BLOG_URL_PLACEHOLDER".

Otherwise, do NOT include a blog link.

Return ONLY the complete HTML file with inline CSS and JavaScript. No markdown, no code fences. Start with <!DOCTYPE html>.
Make it modern, responsive, and beautiful.`;

  return await callGemini(url, systemPrompt + "\n\nUser request: " + userPrompt);
}

async function generateTweak(currentHtml, tweakRequest, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  const prompt = `Existing HTML. Apply these changes: ${tweakRequest}

If user asks to add blog/news/articles, include <a href="BLOG_URL_PLACEHOLDER">Blog</a> in navigation.
Return ONLY the updated HTML.

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

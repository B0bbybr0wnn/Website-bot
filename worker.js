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

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
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

async function handleCallbackQuery(query, env) {
  try {
    const chatId = query.message.chat.id;
    const data = query.data;

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id })
    });

    if (data === "try_another") {
      await env.SITES.put(`domainmode_${chatId}`, "awaiting_name");
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🌐 *Domain Search*\n\nSend me a name to check.`
      );
      return;
    }

    if (data.startsWith("order_")) {
      const domain = data.substring(6);
      await handlePickDomain(chatId, domain, env);
      return;
    }
  } catch (err) {
    console.error("Callback error:", err.message);
  }
}

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
        `💬 *Need help?*\n\nMessage me directly:\n👉 [Chat with support](https://t.me/B0bb_y)`
      );
      return;
    }

    if (userText === "/domain") {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🌐 *Custom Domain*\n\nUse /buydomain to check availability and order.\n\n• Global (.com, .net, .org, .io, .dev) — ₦20,000/year\n• Nigerian (.com.ng) — ₦25,000/year`
      );
      return;
    }

    if (userText === "/buydomain") {
      await env.SITES.put(`domainmode_${chatId}`, "awaiting_name");
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `🌐 *Domain Search*\n\nSend me a name to check.\nExample: \`mybakery\``
      );
      return;
    }

    const domainMode = await env.SITES.get(`domainmode_${chatId}`);
    if (domainMode === "awaiting_name") {
      await handleDomainSearch(chatId, userText, env);
      return;
    }

    if (userText === "/newsite") {
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `➕ *New Website*\n\n🟢 *Starter* — ₦50,000\n🔵 *Business* — ₦85,000\n🟣 *Complex* — ₦180,000\n\nReply with *starter*, *business*, or *complex*.`
      );
      return;
    }

    if (userText === "/mysites") {
      await handleMySites(chatId, env);
      return;
    }

    if (userText.startsWith("/switch")) {
      const parts = userText.split(" ");
      if (!parts[1]) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId, `Usage: /switch 1`);
        return;
      }
      await handleSwitch(chatId, parseInt(parts[1]), env);
      return;
    }

    if (userText.startsWith("/delete")) {
      const parts = userText.split(" ");
      if (!parts[1]) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId, `Usage: /delete 1`);
        return;
      }
      await handleDelete(chatId, parseInt(parts[1]), env);
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
        await sendMessage(env.TELEGRAM_TOKEN, chatId, "You need a live website with a blog first.");
        return;
      }
      const siteData = await env.SITES.get(`site_${activeId}`, "json");
      if (!siteData || !siteData.html.includes("/blog/")) {
        await sendMessage(env.TELEGRAM_TOKEN, chatId, "Your active site doesn't have a blog section.");
        return;
      }
      await sendMessage(env.TELEGRAM_TOKEN, chatId,
        `📝 *Add a blog post*\n\nFormat:\n\`/addpost Title | Body text\``
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
        `✅ *${tier} plan* selected — ₦${price.toLocaleString()}\n\nNow describe your website.\n\n_Changed your mind? Reply /cancel_`
      );
      return;
    }

    const tierData = await env.SITES.get(`tier_${chatId}`, "json");
    if (tierData) {
      const jobId = generateId();
      await env.JOB_QUEUE.send({
        jobId, chatId, userText, tier: tierData.tier, price: tierData.price, createdAt: Date.now()
      });
      await sendMessage(env.TELEGRAM_TOKEN, chatId, "⏳ Generating your website... this takes up to 3 minutes.");
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

    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Reply /start to see the menu.\n\n💬 /support");

  } catch (error) {
    console.error("handleUpdate error:", error.message, error.stack);
  }
}

async function handleDomainSearch(chatId, rawName, env) {
  const name = rawName.toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (!name || name.length < 2) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Invalid name. Try again: /buydomain");
    return;
  }

  await env.SITES.delete(`domainmode_${chatId}`);
  await sendMessage(env.TELEGRAM_TOKEN, chatId, `🔍 Checking "${name}"...`);

  const extensions = [
    { ext: ".com", price: 20000, rdap: `https://rdap.verisign.com/com/v1/domain/${name}.com` },
    { ext: ".net", price: 20000, rdap: `https://rdap.verisign.com/net/v1/domain/${name}.net` },
    { ext: ".org", price: 20000, rdap: `https://rdap.publicinterestregistry.org/rdap/domain/${name}.org` },
    { ext: ".io", price: 20000, rdap: `https://rdap.identitydigital.services/rdap/domain/${name}.io` },
    { ext: ".dev", price: 20000, rdap: `https://www.registry.google/rdap/domain/${name}.dev` },
    { ext: ".com.ng", price: 25000, rdap: `https://rdap.nic.net.ng/domain/${name}.com.ng` }
  ];

  const results = await Promise.all(
    extensions.map(async (e) => {
      try {
        const res = await fetch(e.rdap, {
          headers: { "Accept": "application/rdap+json" },
          redirect: "follow"
        });

        let available = res.status === 404;

        if (!available && res.status === 200) {
          try {
            const text = await res.text();
            if (text.includes('"errorCode":404') || text.includes("NOT_FOUND") || text.includes("not found")) {
              available = true;
            }
          } catch (e) {}
        }

        return { ...e, available };
      } catch (err) {
        return { ...e, available: null };
      }
    })
  );

  const available = results.filter(r => r.available === true);

  let list = "";
  results.forEach(r => {
    if (r.available === true) list += `✅ ${name}${r.ext} — ₦${r.price.toLocaleString()}\n`;
    else if (r.available === false) list += `❌ ${name}${r.ext}\n`;
    else list += `⚠️ ${name}${r.ext}\n`;
  });

  const buttons = [];
  if (available.length > 0) {
    const row = available.map(a => ({ text: `✅ ${a.ext}`, callback_data: `order_${name}${a.ext}` }));
    buttons.push(row);
  }
  buttons.push([{ text: "🔄 Try Another", callback_data: "try_another" }]);

  await sendMessageWithButtons(env.TELEGRAM_TOKEN, chatId, list, buttons);
}

async function handlePickDomain(chatId, domain, env) {
  const validExts = [".com", ".net", ".org", ".io", ".dev", ".com.ng"];
  const ext = validExts.find(e => domain.endsWith(e));
  if (!ext) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Invalid. Use /buydomain.");
    return;
  }

  const price = ext === ".com.ng" ? 25000 : 20000;

  const paystackData = await initPaystack(chatId, price, env.PAYSTACK_SECRET_KEY, null, "domain", domain);
  if (paystackData && paystackData.authorization_url) {
    const shortUrl = await shortenUrl(paystackData.authorization_url);
    await sendMessage(env.TELEGRAM_TOKEN, chatId,
      `💳 *${domain}*\n₦${price.toLocaleString()}\n\n${shortUrl}`
    );
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed. Reply /support");
  }
}

async function shortenUrl(longUrl) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
    if (res.ok) {
      const short = await res.text();
      if (short.startsWith("http")) return short;
    }
  } catch (e) {}
  return longUrl;
}

async function sendMessageWithButtons(token, chatId, text, buttons) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons }
    })
  });
}

async function sendStartMessage(chatId, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  const paidSites = sites.filter(s => s.paid === true);

  let hasBlog = false;
  if (paidSites.length > 0) {
    const activeId = await env.SITES.get(`active_${chatId}`);
    if (activeId) {
      const siteData = await env.SITES.get(`site_${activeId}`, "json");
      if (siteData && siteData.html.includes("/blog/")) hasBlog = true;
    }
  }

  let menu = "👋 Welcome to *WebPanda*!\n\n";
  if (sites.length === 0) {
    menu += "➕ /newsite — Build a website\n🌐 /buydomain — Get a domain\n💬 /support — Get help\n";
  } else if (paidSites.length === 0) {
    menu += "➕ /newsite — Build a new website\n🌐 /mysites — View your preview\n🌐 /buydomain — Get a domain\n💬 /support — Get help\n";
  } else {
    menu += "➕ /newsite — Build a new website\n🌐 /mysites — Manage your websites\n";
    if (hasBlog) menu += "📝 /addpost — Add a blog post\n📋 /listposts — See your posts\n";
    menu += "🌐 /buydomain — Get a domain\n💬 /support — Get help\n";
  }

  menu += "\n📜 [Terms and Conditions](https://github.com/B0bbybr0wnn/Website-bot/blob/main/terms.md)";
  await sendMessage(env.TELEGRAM_TOKEN, chatId, menu);
}

async function handleAddPost(chatId, text, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "You need a live blog site first.");
    return;
  }
  const siteData = await env.SITES.get(`site_${activeId}`, "json");
  if (!siteData || !siteData.html.includes("/blog/")) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Your active site doesn't have a blog.");
    return;
  }
  const parts = text.split("|");
  if (parts.length < 2) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `❌ Format: /addpost Title | Body text`);
    return;
  }
  const title = parts[0].trim();
  const body = parts.slice(1).join("|").trim();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50);

  try {
    await env.BLOG_DB.prepare(
      "INSERT INTO posts (site_id, title, slug, body, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(activeId, title, slug, body, Date.now()).run();

    const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `✅ Post added!\n\n${baseUrl}/blog/${activeId}`);
  } catch (err) {
    console.error("Add post error:", err.message);
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed. Reply /support.");
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
      await sendMessage(env.TELEGRAM_TOKEN, chatId, "No posts yet. Add one with /addpost");
      return;
    }
    let list = "📋 *Your Posts:*\n\n";
    result.results.forEach((p, i) => { list += `*${i + 1}.* ${p.title}  \`ID: ${p.id}\`\n`; });
    list += "\nDelete: `/deletepost ID`";
    await sendMessage(env.TELEGRAM_TOKEN, chatId, list);
  } catch (err) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed.");
  }
}

async function handleDeletePost(chatId, postId, env) {
  const activeId = await env.SITES.get(`active_${chatId}`);
  if (!activeId || !postId || isNaN(postId)) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid. Use /listposts.");
    return;
  }
  try {
    await env.BLOG_DB.prepare("DELETE FROM posts WHERE id = ? AND site_id = ?").bind(postId, activeId).run();
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `🗑️ Post deleted.`);
  } catch (err) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed.");
  }
}

async function handleBlogPage(siteId, env) {
  try {
    const result = await env.BLOG_DB.prepare(
      "SELECT title, slug, body, created_at FROM posts WHERE site_id = ? ORDER BY created_at DESC"
    ).bind(siteId).all();

    const posts = result.results || [];
    let postsHtml = posts.length === 0
      ? `<p style="text-align:center;color:#888;padding:60px 20px;">No posts yet.</p>`
      : posts.map(p => {
          const date = new Date(p.created_at).toLocaleDateString();
          return `<article style="margin-bottom:48px;padding-bottom:32px;border-bottom:1px solid #eee;"><h2 style="font-size:28px;margin:0 0 8px;color:#111;">${escapeHtml(p.title)}</h2><p style="color:#888;font-size:13px;margin:0 0 16px;">${date}</p><div style="color:#333;line-height:1.7;">${escapeHtml(p.body).replace(/\n/g, "<br>")}</div></article>`;
        }).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Blog</title>
<style>body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 0 auto; padding: 40px 20px; background: #fff; color: #111; }
h1 { font-size: 36px; margin-bottom: 40px; border-bottom: 3px solid #ff6b00; padding-bottom: 12px; display: inline-block; }</style></head>
<body><h1>Blog</h1>${postsHtml}</body></html>`;

    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    return new Response("Blog error", { status: 500 });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleMySites(chatId, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (sites.length === 0) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "No websites yet. /newsite");
    return;
  }
  const activeId = await env.SITES.get(`active_${chatId}`);
  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  let list = "🌐 *Your Websites:*\n\n";
  sites.forEach((s, i) => {
    const isActive = s.siteId === activeId ? " ⬅️" : "";
    const status = s.paid ? `✅ ${s.tweaksLimit - s.tweaksUsed} edits` : `⏳ Preview`;
    list += `*${i + 1}.* ${s.name} — ${status}${isActive}\n${baseUrl}/site/${s.siteId}\n\n`;
  });
  list += "`/switch N` · `/delete N`";
  await sendMessage(env.TELEGRAM_TOKEN, chatId, list);
}

async function handleSwitch(chatId, index, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (index < 1 || index > sites.length) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid. /mysites");
    return;
  }
  const site = sites[index - 1];
  await env.SITES.put(`active_${chatId}`, site.siteId);
  await sendMessage(env.TELEGRAM_TOKEN, chatId,
    `✅ Now editing: *${site.name}*\n${site.tweaksLimit - site.tweaksUsed} edits remaining.`
  );
}

async function handleDelete(chatId, index, env) {
  const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
  if (index < 1 || index > sites.length) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Invalid. /mysites");
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
    const shortUrl = await shortenUrl(paystackData.authorization_url);
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `💳 ₦3,000 for 5 edits:\n${shortUrl}`);
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "❌ Failed.");
  }
}

async function handleTweakRequest(chatId, userText, site, env) {
  if (site.tweaksUsed >= site.tweaksLimit) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `🔒 Edits used. Pay ₦3,000 for 5 more: /pay_tweak`);
    return;
  }
  await env.JOB_QUEUE.send({
    jobId: generateId(), chatId, userText, siteId: site.siteId, isTweak: true, createdAt: Date.now()
  });
  await sendMessage(env.TELEGRAM_TOKEN, chatId, "⏳ Applying changes... up to 3 minutes.");
}

async function processNewSiteJob(job, env) {
  const websiteCode = await generateWebsite(job.userText, job.tier, env.GEMINI_API_KEY);
  if (websiteCode.startsWith("⏳")) throw new Error("busy");

  const siteId = generateId();
  const siteName = job.userText.substring(0, 30);
  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  const finalHtml = websiteCode.replace(/BLOG_URL_PLACEHOLDER/g, `${baseUrl}/blog/${siteId}`);

  await env.SITES.put(`site_${siteId}`, JSON.stringify({ html: finalHtml, paid: false }));

  const sites = await env.SITES.get(`sites_${job.chatId}`, "json") || [];
  sites.push({ siteId, tier: job.tier, price: job.price, name: siteName, tweaksUsed: 0, tweaksLimit: 0, paid: false, createdAt: Date.now() });
  await env.SITES.put(`sites_${job.chatId}`, JSON.stringify(sites));

  const paystackData = await initPaystack(job.chatId, job.price, env.PAYSTACK_SECRET_KEY, siteId);
  if (!paystackData || !paystackData.authorization_url) {
    await sendMessage(env.TELEGRAM_TOKEN, job.chatId, "❌ Failed. /support");
    return;
  }

  const shortUrl = await shortenUrl(paystackData.authorization_url);
  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ Preview: ${baseUrl}/site/${siteId}\n\n💳 Unlock for ₦${job.price.toLocaleString()}:\n${shortUrl}`
  );
}

async function processTweakJob(job, env) {
  const siteData = await env.SITES.get(`site_${job.siteId}`, "json");
  if (!siteData) throw new Error("not found");

  const updatedHtml = await generateTweak(siteData.html, job.userText, env.GEMINI_API_KEY);
  if (!updatedHtml || updatedHtml.startsWith("⏳")) throw new Error("busy");

  siteData.html = updatedHtml;
  await env.SITES.put(`site_${job.siteId}`, JSON.stringify(siteData));

  const sites = await env.SITES.get(`sites_${job.chatId}`, "json") || [];
  const site = sites.find(s => s.siteId === job.siteId);
  if (site) { site.tweaksUsed++; await env.SITES.put(`sites_${job.chatId}`, JSON.stringify(sites)); }

  const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
  await sendMessage(env.TELEGRAM_TOKEN, job.chatId,
    `✅ Changes applied!\n${baseUrl}/site/${job.siteId}\n\n${site.tweaksLimit - site.tweaksUsed} edits remaining.`
  );
}

async function handlePaystackWebhook(request, env) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(env.PAYSTACK_SECRET_KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(rawBody));
    const hash = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== request.headers.get("x-paystack-signature")) return new Response("Invalid", { status: 401 });

    if (body.event === "charge.success") {
      const m = body.data.metadata || {};
      const chatId = m.chatId;
      if (!chatId) return new Response("OK", { status: 200 });

      if (m.type === "tweak") {
        const activeId = await env.SITES.get(`active_${chatId}`);
        if (activeId) {
          const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
          const site = sites.find(s => s.siteId === activeId);
          if (site) { site.tweaksLimit += 5; await env.SITES.put(`sites_${chatId}`, JSON.stringify(sites)); }
        }
        await sendMessage(env.TELEGRAM_TOKEN, chatId, `🎉 5 more edits unlocked.`);
        return new Response("OK", { status: 200 });
      }

      if (m.type === "domain" && m.domain) {
        await sendMessage(env.TELEGRAM_TOKEN, "6778703420",
          `🔔 Domain order: *${m.domain}*\nChat: \`${chatId}\``
        );
        await sendMessage(env.TELEGRAM_TOKEN, chatId,
          `🎉 Paid! Registering *${m.domain}*. Takes 1-2 hours.`
        );
        return new Response("OK", { status: 200 });
      }

      if (m.siteId) {
        const sd = await env.SITES.get(`site_${m.siteId}`, "json");
        if (sd) { sd.paid = true; await env.SITES.put(`site_${m.siteId}`, JSON.stringify(sd)); }

        const sites = await env.SITES.get(`sites_${chatId}`, "json") || [];
        const site = sites.find(s => s.siteId === m.siteId);
        if (site) {
          site.paid = true; site.tweaksUsed = 0; site.tweaksLimit = 3;
          await env.SITES.put(`sites_${chatId}`, JSON.stringify(sites));
          await env.SITES.put(`active_${chatId}`, m.siteId);
        }

        const baseUrl = "https://website-bot.bobbyjohon8585.workers.dev";
        const hasBlog = sd && sd.html.includes("/blog/");

        let msg = `🎉 *Your site is live!*\n\n`;
        msg += `🔗 ${baseUrl}/site/${m.siteId}\n`;
        if (hasBlog) msg += `📝 Blog: ${baseUrl}/blog/${m.siteId}\n`;
        msg += `\n⚠️ _This is a temporary link — not something you'd share with customers._\n\n`;
        msg += `🌐 Want a professional address like *yourbusiness.com*?\nReply /buydomain to get one.\n\n`;
        msg += `✏️ You also have 3 free edits — just describe any change.`;

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
      body: JSON.stringify({ email: `user${chatId}@webpanda.app`, amount: amount * 100, currency: "NGN", metadata })
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
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
  const prompt = `Existing HTML. Apply: ${tweakRequest}

If user asks for blog/news/articles, include <a href="BLOG_URL_PLACEHOLDER">Blog</a> in nav.
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

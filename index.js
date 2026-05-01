require("dotenv").config();

const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();

app.use(express.json());

const DB_FILE = "payments.json";
const PAYMENT_COOLDOWN_MS = 30 * 1000;
const PAYMENT_REMINDER_MS = 30 * 60 * 1000;
const REMINDER_CHECK_MS = 5 * 60 * 1000;
const paymentCooldowns = new Map();
const depositSessions = new Map();

const COINS = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
};

function loadPayments() {
  if (!fs.existsSync(DB_FILE)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function savePayments(payments) {
  fs.writeFileSync(DB_FILE, JSON.stringify(payments, null, 2));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(value) {
  if (!value) {
    return "not updated yet";
  }

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function londonDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function getStatusExplanation(status) {
  const cleanStatus = String(status || "unknown").toLowerCase();

  const statuses = {
    waiting: "Waiting for payment",
    confirming: "Payment detected and confirming on the blockchain",
    confirmed: "Payment confirmed and processing",
    sending: "Payment confirmed and finalising",
    finished: "Payment successful",
    partially_paid: "Partially paid - contact support @qevybtc",
    failed: "Payment failed - contact support @qevybtc",
    expired: "Payment expired - create a new payment",
    cancelled: "Payment cancelled - contact support @qevybtc",
    wrong_asset_confirmed: "Wrong coin or network detected - contact support @qevybtc",
  };

  return statuses[cleanStatus] || cleanStatus;
}

function getUserStatusMessage(status) {
  const cleanStatus = String(status || "").toLowerCase();

  const messages = {
    confirming: "Payment detected. It is confirming on the blockchain.",
    confirmed: "Payment confirmed. Finalising your access...",
    sending: "Payment confirmed. Finalising your access...",
    partially_paid: "Your payment was received, but it was not the full amount. Please contact @qevybtc.",
    failed: "Your payment failed. Please contact @qevybtc.",
    expired: "Your payment has expired. Please press Get Access to create a new payment.",
    cancelled: "Your payment was cancelled. Please contact @qevybtc.",
    wrong_asset_confirmed: "The wrong coin or network was detected. Please contact @qevybtc.",
  };

  return messages[cleanStatus] || "";
}

function isAdmin(ctx) {
  return String(ctx.from.id) === String(process.env.ADMIN_TELEGRAM_ID);
}

async function sendAdminMessage(message) {
  if (!process.env.ADMIN_TELEGRAM_ID) {
    return;
  }

  try {
    await bot.telegram.sendMessage(process.env.ADMIN_TELEGRAM_ID, message, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Could not send admin message:", error.message);
  }
}

function getUserPayments(userId, chatId) {
  const payments = loadPayments();

  return Object.entries(payments).filter(
    ([paymentId, payment]) =>
      String(payment.chatId) === String(chatId) ||
      String(payment.telegramUserId) === String(userId)
  );
}

function userHasAccess(userId, chatId) {
  return getUserPayments(userId, chatId).some(
    ([paymentId, payment]) => payment.status === "finished"
  );
}

function getMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Get Access", "pay")],
    [Markup.button.callback("My Payment Status", "status")],
    [
      Markup.button.callback("▪️ Deposit", "deposit"),
      Markup.button.callback("▫️ Withdraw", "withdraw"),
    ],
    [
      Markup.button.callback("🎯 Snipe Bot", "snipe_bot"),
      Markup.button.callback("✨ Bot Filters", "bot_filters"),
    ],
    [
      Markup.button.callback("📊 Account", "account"),
      Markup.button.callback("🎁 Referral", "referral"),
    ],
    [
      Markup.button.callback("👥 Help", "help"),
      Markup.button.callback("📕 Support", "support"),
    ],
    [
      Markup.button.callback("📌 Terms", "terms"),
      Markup.button.callback("🔔 Updates", "updates"),
    ],
    [Markup.button.callback("❓ FAQ", "faq")],
    [Markup.button.callback("💠 How To Buy Crypto", "how_to_buy_crypto")],
  ]);
}

function formatTransaction(paymentId, payment, number) {
  const title = number ? `<b>${number}. Transaction</b>` : "<b>Transaction</b>";

  return [
    title,
    `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
    `Status: <b>${escapeHtml(payment.status || "unknown")}</b>`,
    `Status Detail: ${escapeHtml(getStatusExplanation(payment.status))}`,
    `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
    `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
    `Address: <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
    `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
    `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
    `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
    `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
    `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
  ].join("\n");
}

function getPaymentCooldownSeconds(userId) {
  const cooldownUntil = paymentCooldowns.get(String(userId)) || 0;
  const remaining = cooldownUntil - Date.now();

  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function startPaymentCooldown(userId) {
  paymentCooldowns.set(String(userId), Date.now() + PAYMENT_COOLDOWN_MS);
}

function calculateRevenue(entries) {
  return entries
    .filter(([paymentId, payment]) => payment.status === "finished")
    .reduce((total, [paymentId, payment]) => {
      const amount = Number.parseFloat(payment.priceAmount || process.env.PRICE_AMOUNT || "0");
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
}

function isActiveUnpaidStatus(status) {
  return ["waiting", "confirming", "confirmed", "sending"].includes(
    String(status || "").toLowerCase()
  );
}

async function sendPaymentReminderIfNeeded(paymentId) {
  const payments = loadPayments();
  const payment = payments[paymentId];

  if (!payment || payment.reminderSentAt || !isActiveUnpaidStatus(payment.status)) {
    return;
  }

  const createdAt = payment.createdAt ? new Date(payment.createdAt).getTime() : 0;

  if (!createdAt || Date.now() - createdAt < PAYMENT_REMINDER_MS) {
    return;
  }

  payment.reminderSentAt = new Date().toISOString();
  savePayments(payments);

  await bot.telegram.sendMessage(
    payment.chatId,
    "Your payment is still waiting. Complete it or create a new one by pressing Get Access.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Create New Payment", callback_data: "pay" }]],
      },
    }
  );
}

async function scanPaymentReminders() {
  const payments = loadPayments();

  for (const paymentId of Object.keys(payments)) {
    await sendPaymentReminderIfNeeded(paymentId);
  }
}

function sortObject(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((result, key) => {
      if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
        result[key] = sortObject(obj[key]);
      } else {
        result[key] = obj[key];
      }

      return result;
    }, {});
}

function verifyNowPaymentsSignature(body, receivedSignature) {
  if (!receivedSignature) {
    return false;
  }

  const hmac = crypto.createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET);
  hmac.update(JSON.stringify(sortObject(body)));

  const expectedSignature = hmac.digest("hex");

  return (
    expectedSignature.length === receivedSignature.length &&
    crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(receivedSignature)
    )
  );
}

bot.command("myid", async (ctx) => {
  await ctx.reply(`Your Telegram ID is: ${ctx.from.id}`);
});

bot.command("commands", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  await ctx.reply(
    [
      "<b>Admin Commands</b>",
      "",
      "<code>/commands</code> - Shows this command list",
      "<code>/myid</code> - Shows your Telegram user ID",
      "<code>/stats</code> - Shows total bot stats",
      "<code>/today</code> - Shows today's transactions",
      "<code>/revenue</code> - Shows estimated revenue",
      "<code>/user USER_ID</code> - Shows transactions for one user",
      "<code>/transactions</code> - Shows the latest 10 attempted transactions",
      "<code>/transaction PAYMENT_ID</code> - Shows one specific transaction",
      "<code>/paidusers</code> - Shows users with successful payments",
      "<code>/export</code> - Sends the payments.json file",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const payments = loadPayments();
  const entries = Object.entries(payments);
  const todayKey = londonDateKey(new Date());

  const todayEntries = entries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  const countStatus = (status) =>
    entries.filter(([paymentId, payment]) => payment.status === status).length;

  await ctx.reply(
    [
      "<b>Bot Stats</b>",
      "",
      `Total attempts: ${entries.length}`,
      `Today attempts: ${todayEntries.length}`,
      `Finished: ${countStatus("finished")}`,
      `Waiting: ${countStatus("waiting")}`,
      `Confirming: ${countStatus("confirming")}`,
      `Expired: ${countStatus("expired")}`,
      `Failed: ${countStatus("failed")}`,
      `Partially paid: ${countStatus("partially_paid")}`,
      `Estimated revenue: ${calculateRevenue(entries).toFixed(2)} ${escapeHtml((process.env.PRICE_CURRENCY || "usd").toUpperCase())}`,
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.command("today", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const payments = loadPayments();
  const entries = Object.entries(payments);
  const todayKey = londonDateKey(new Date());

  const todayEntries = entries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  if (todayEntries.length === 0) {
    await ctx.reply("No transactions today.");
    return;
  }

  const latestToday = todayEntries.slice(-10);

  const message = latestToday
    .map(([paymentId, payment], index) => {
      const number = latestToday.length - index;
      return formatTransaction(paymentId, payment, number);
    })
    .join("\n\n");

  await ctx.reply(message, {
    parse_mode: "HTML",
  });
});

bot.command("revenue", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const payments = loadPayments();
  const entries = Object.entries(payments);
  const todayKey = londonDateKey(new Date());

  const todayEntries = entries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  await ctx.reply(
    [
      "<b>Revenue</b>",
      "",
      `Today: ${calculateRevenue(todayEntries).toFixed(2)} ${escapeHtml((process.env.PRICE_CURRENCY || "usd").toUpperCase())}`,
      `Total: ${calculateRevenue(entries).toFixed(2)} ${escapeHtml((process.env.PRICE_CURRENCY || "usd").toUpperCase())}`,
      "",
      "Revenue is estimated from finished payments using your configured price amount.",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.command("user", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const query = ctx.message.text.split(" ")[1];

  if (!query) {
    await ctx.reply("Use it like this: /user USER_ID");
    return;
  }

  const cleanQuery = query.replace("@", "").toLowerCase();
  const payments = loadPayments();

  const userEntries = Object.entries(payments).filter(([paymentId, payment]) => {
    const username = String(payment.telegramUsername || "").replace("@", "").toLowerCase();

    return (
      String(payment.telegramUserId || "") === cleanQuery ||
      String(payment.chatId || "") === cleanQuery ||
      username === cleanQuery
    );
  });

  if (userEntries.length === 0) {
    await ctx.reply("No transactions found for this user.");
    return;
  }

  const latestUserPayments = userEntries.slice(-10);

  const message = latestUserPayments
    .map(([paymentId, payment], index) => {
      const number = latestUserPayments.length - index;
      return formatTransaction(paymentId, payment, number);
    })
    .join("\n\n");

  await ctx.reply(message, {
    parse_mode: "HTML",
  });
});

bot.command("transactions", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const payments = loadPayments();
  const entries = Object.entries(payments);

  if (entries.length === 0) {
    await ctx.reply("No attempted transactions yet.");
    return;
  }

  const latestPayments = entries.slice(-10);

  const message = latestPayments
    .map(([paymentId, payment], index) => {
      const number = latestPayments.length - index;
      return formatTransaction(paymentId, payment, number);
    })
    .join("\n\n");

  await ctx.reply(message, {
    parse_mode: "HTML",
  });
});

bot.command("transaction", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const paymentId = ctx.message.text.split(" ")[1];

  if (!paymentId) {
    await ctx.reply("Use it like this: /transaction PAYMENT_ID");
    return;
  }

  const payments = loadPayments();
  const payment = payments[paymentId];

  if (!payment) {
    await ctx.reply("Transaction not found.");
    return;
  }

  await ctx.reply(formatTransaction(paymentId, payment), {
    parse_mode: "HTML",
  });
});

bot.command("paidusers", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const payments = loadPayments();
  const paidEntries = Object.entries(payments).filter(
    ([paymentId, payment]) => payment.status === "finished"
  );

  if (paidEntries.length === 0) {
    await ctx.reply("No paid users yet.");
    return;
  }

  const paidUsers = new Map();

  for (const [paymentId, payment] of paidEntries) {
    const userId = payment.telegramUserId || payment.chatId || paymentId;

    paidUsers.set(String(userId), {
      paymentId,
      payment,
    });
  }

  const latestPaidUsers = Array.from(paidUsers.values()).slice(-20);

  const message = latestPaidUsers
    .map(({ paymentId, payment }, index) => {
      return [
        `<b>${index + 1}. Paid User</b>`,
        `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
        `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
        `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
        `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
        `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
        `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
        `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
      ].join("\n");
    })
    .join("\n\n");

  await ctx.reply(message, {
    parse_mode: "HTML",
  });
});

bot.command("export", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  if (!fs.existsSync(DB_FILE)) {
    await ctx.reply("No payments file exists yet.");
    return;
  }

  await ctx.replyWithDocument({
    source: DB_FILE,
    filename: "payments.json",
  });
});

bot.start(async (ctx) => {
  const menu = getMainMenuKeyboard();

  if (process.env.WELCOME_IMAGE_URL) {
    try {
      await ctx.replyWithPhoto(process.env.WELCOME_IMAGE_URL, {
        caption: "Welcome to Kevy Trading Bot.\n\nYour automated crypto trading assistant built to help you access powerful trading features with a simple one-time setup.\n\nChoose an option below to get started.",
        ...menu,
      });
      return;
    } catch (error) {
      console.error("Could not send welcome image:", error.message);
    }
  }

  await ctx.reply("Welcome. Choose an option:", menu);
});

bot.action("account", async (ctx) => {
  await ctx.answerCbQuery();

  const payments = getUserPayments(ctx.from.id, ctx.chat.id);
  const latestPayment = payments.length ? payments[payments.length - 1] : null;
  const hasAccess = userHasAccess(ctx.from.id, ctx.chat.id);

  await ctx.reply(
    [
      "<b>📊 Account</b>",
      "",
      `User ID: <code>${escapeHtml(ctx.from.id)}</code>`,
      `Username: ${escapeHtml(ctx.from.username ? `@${ctx.from.username}` : "none")}`,
      `Access: ${hasAccess ? "Active" : "Not active"}`,
      latestPayment ? `Latest Payment ID: <code>${escapeHtml(latestPayment[0])}</code>` : "Latest Payment ID: none",
      latestPayment ? `Latest Status: ${escapeHtml(latestPayment[1].status || "unknown")}` : "Latest Status: none",
      latestPayment ? `Created: ${escapeHtml(formatTimestamp(latestPayment[1].createdAt))}` : "Created: not updated yet",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("referral", async (ctx) => {
  await ctx.answerCbQuery();

  const botUsername = ctx.botInfo && ctx.botInfo.username ? ctx.botInfo.username : "YOUR_BOT_USERNAME";
  const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;

  await ctx.reply(
    [
      "<b>🎁 Referral</b>",
      "",
      "Your referral link:",
      `<code>${escapeHtml(referralLink)}</code>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("terms", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>📌 Terms</b>",
      "",
      "We offer full refunds if you are not satisfied with the bot.",
      "Always send funds using the correct coin and network.",
      "Trading involves risk and results are not guaranteed.",
      "If you need help, contact @qevybtc.",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("updates", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>🔔 Updates</b>",
      "",
      "Updates channel: https://t.me/kevybotupdates",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("faq", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>❓ FAQ</b>",
      "",
      "<b>How do I get access?</b>",
      "Press Get Access, choose a crypto, and send the exact amount shown.",
      "",
      "<b>How long does payment take?</b>",
      "It depends on the blockchain network. Some payments can take a few minutes.",
      "",
      "<b>What if I send the wrong coin or network?</b>",
      "Contact @qevybtc.",
      "",
      "<b>What if my payment expires?</b>",
      "Press Get Access again to create a new payment.",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "Choose which crypto you want to deposit with:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Bitcoin", "deposit_coin:btc")],
      [Markup.button.callback("Ethereum", "deposit_coin:eth")],
      [Markup.button.callback("Solana", "deposit_coin:sol")],
    ])
  );
});

bot.action(/^deposit_coin:(btc|eth|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const coin = ctx.match[1];

  depositSessions.set(String(ctx.from.id), {
    coin,
  });

  await ctx.reply(
    [
      `<b>Please enter the amount you would like to deposit in USD using ${COINS[coin]}</b>`,
      "",
      "The minimum amount to deposit is $20, anything under that will be voided and you will not recieve it in your wallet.",
      "",
      "<b>Example: $50</b>",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("withdraw", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>Please select which way you would like to withdraw your funds.</b>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏦 Bank Transfer", callback_data: "withdraw_bank" }],
          [{ text: "🪙 Crypto Wallet", callback_data: "withdraw_crypto" }],
        ],
      },
    }
  );
});

bot.action("withdraw_bank", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>You have $0 funds to withdraw, please deposit using the menu above.</b>",
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("withdraw_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>You have $0 funds to withdraw, please deposit using the menu above.</b>",
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("snipe_bot", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "You have deposited 0 funds into your account, please deposit using the menu above to continue."
  );
});

bot.action("bot_filters", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "You have deposited 0 funds into your account, please deposit using the menu above to continue."
  );
});

bot.action("how_to_buy_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>How To Buy Crypto📈</b>",
      "",
      "<b>https://www.youtube.com/watch?v=TryloIYvi1U</b>",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("help", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>Help</b>",
      "",
      "To use this profitable trading bot, press Get Access, choose Bitcoin, Ethereum, or Solana, then send the exact amount to the address shown.",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>Support</b>",
      "",
      "For support, contact: @qevybtc",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("status", async (ctx) => {
  await ctx.answerCbQuery();

  const userPayments = getUserPayments(ctx.from.id, ctx.chat.id);

  if (userPayments.length === 0) {
    await ctx.reply(
      [
        "<b>My payment status</b>",
        "",
        "You do not have any payments yet.",
      ].join("\n"),
      {
        parse_mode: "HTML",
      }
    );
    return;
  }

  const [paymentId, payment] = userPayments[userPayments.length - 1];
  const status = String(payment.status || "").toLowerCase();
  const extraOptions =
    status === "expired"
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Create New Payment", callback_data: "pay" }]],
          },
        }
      : {};

  await ctx.reply(
    [
      "<b>My payment status</b>",
      "",
      "Latest payment:",
      `Payment ID: ${escapeHtml(paymentId)}`,
      `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
      `Status: ${escapeHtml(payment.status || "unknown")}`,
      `Status Detail: ${escapeHtml(getStatusExplanation(payment.status))}`,
      `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
      `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
      `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...extraOptions,
    }
  );
});

bot.action("pay", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("You already have free access. Use the menu above to continue.");
});

bot.action(/^coin:(btc|eth|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("This payment option is no longer available. Please use ▪️ Deposit instead.");
});

bot.action("how_to_buy_crypto_easy", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>How to buy crypto (easy)</b>",
      "",
      "https://www.youtube.com/watch?v=TryloIYvi1U",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.on("text", async (ctx, next) => {
  const session = depositSessions.get(String(ctx.from.id));

  if (!session) {
    return next();
  }

  const amountText = ctx.message.text.replace(/[$,]/g, "").trim();
  const amount = Number.parseFloat(amountText);

  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Please enter a valid deposit amount. Example: $50");
    return;
  }

  if (amount < 20) {
    await ctx.reply("Minimum deposit amount is 20 USD. Please enter a higher amount.");
    return;
  }

  depositSessions.delete(String(ctx.from.id));

  const coin = session.coin;
  const chatId = ctx.chat.id;
  const orderId = `deposit_${chatId}_${Date.now()}`;
  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : "";
  const telegramName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");

  await ctx.reply(`Creating your ${COINS[coin]} deposit...`);

  try {
    const response = await axios.post(
      `${process.env.NOWPAYMENTS_BASE_URL}/payment`,
      {
        price_amount: amount,
        price_currency: "usd",
        pay_currency: coin,
        ipn_callback_url: `${process.env.PUBLIC_BASE_URL}/nowpayments-ipn`,
        order_id: orderId,
        order_description: `Telegram deposit from user ${chatId}`,
      },
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const payment = response.data;

    if (!payment.payment_id || !payment.pay_address) {
      await ctx.reply("Deposit was created, but no wallet address was returned. Check the VS Code terminal.");
      return;
    }

    const payments = loadPayments();

    payments[payment.payment_id] = {
      paymentId: payment.payment_id,
      chatId,
      telegramUserId: ctx.from.id,
      telegramUsername,
      telegramName,
      orderId,
      coin,
      coinName: COINS[coin],
      status: payment.payment_status || "waiting",
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount ? `${payment.pay_amount} ${coin.toUpperCase()}` : "",
      priceAmount: amount,
      priceCurrency: "usd",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      actuallyPaid: "",
      outcomeAmount: "",
      outcomeCurrency: "",
      reminderSentAt: "",
      ipnHistory: [],
      type: "deposit",
    };

    savePayments(payments);

    console.log("Sending admin deposit alert...");

    await sendAdminMessage(
      [
        "<b>New deposit attempt</b>",
        `Payment ID: <code>${escapeHtml(payment.payment_id)}</code>`,
        `User ID: <code>${escapeHtml(ctx.from.id)}</code>`,
        `Username: ${escapeHtml(telegramUsername || "none")}`,
        `Name: ${escapeHtml(telegramName || "unknown")}`,
        `Coin: ${escapeHtml(coin.toUpperCase())}`,
        `Amount: ${escapeHtml(amount)} USD`,
        `Crypto Amount: ${escapeHtml(payment.pay_amount ? `${payment.pay_amount} ${coin.toUpperCase()}` : "unknown")}`,
        `Address: <code>${escapeHtml(payment.pay_address)}</code>`,
        `Created: ${escapeHtml(formatTimestamp(new Date().toISOString()))}`,
      ].join("\n")
    );

    await ctx.reply(
      [
        `<b>Send ${COINS[coin]} deposit to this address:</b>`,
        "",
        `<code>${escapeHtml(payment.pay_address)}</code>`,
        "",
        payment.pay_amount
          ? `<b>Amount:</b> <code>${payment.pay_amount} ${coin.toUpperCase()}</code>`
          : `<b>Amount:</b> ${amount} USD worth of ${coin.toUpperCase()}`,
        "",
        "Use the correct network only.",
        `<b>Payment ID:</b> <code>${escapeHtml(payment.payment_id)}</code>`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Copy address",
                copy_text: {
                  text: payment.pay_address,
                },
              },
            ],
            [
              {
                text: "How to buy crypto (easy)",
                callback_data: "how_to_buy_crypto_easy",
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error(error.response?.data || error.message);
    await ctx.reply("Sorry, I could not create the deposit. Please try again.");
  }
});

app.post("/nowpayments-ipn", async (req, res) => {
  const signature = req.headers["x-nowpayments-sig"];

  if (!verifyNowPaymentsSignature(req.body, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const { payment_id, payment_status } = req.body;
  const payments = loadPayments();
  const payment = payments[payment_id];

  if (!payment) {
    return res.status(200).send("Unknown payment");
  }

  const previousStatus = payment.status || "unknown";
  const newStatus = payment_status || previousStatus;

  payment.status = newStatus;
  payment.updatedAt = new Date().toISOString();
  payment.nowpaymentsStatus = newStatus;
  payment.actuallyPaid = req.body.actually_paid || payment.actuallyPaid || "";
  payment.outcomeAmount = req.body.outcome_amount || payment.outcomeAmount || "";
  payment.outcomeCurrency = req.body.outcome_currency || payment.outcomeCurrency || "";

  if (!payment.ipnHistory) {
    payment.ipnHistory = [];
  }

  payment.ipnHistory.push({
    status: newStatus,
    receivedAt: new Date().toISOString(),
    actuallyPaid: req.body.actually_paid || "",
    outcomeAmount: req.body.outcome_amount || "",
    outcomeCurrency: req.body.outcome_currency || "",
  });

  savePayments(payments);

  if (newStatus !== previousStatus) {
    await sendAdminMessage(
      [
        "<b>Payment status update</b>",
        `Payment ID: <code>${escapeHtml(payment_id)}</code>`,
        `Previous: ${escapeHtml(previousStatus)}`,
        `New: <b>${escapeHtml(newStatus)}</b>`,
        `Detail: ${escapeHtml(getStatusExplanation(newStatus))}`,
        `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
        `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
        `Actually paid: ${escapeHtml(payment.actuallyPaid || "unknown")}`,
        `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
      ].join("\n")
    );
  }

  if (newStatus === "finished" && previousStatus !== "finished") {
    await bot.telegram.sendMessage(
      payment.chatId,
      "Welcome, you now have access to Kevy The Trading Bot. Please contact @qevybtc to get started."
    );
  }

  if (newStatus !== "finished" && newStatus !== previousStatus) {
    const userMessage = getUserStatusMessage(newStatus);

    if (userMessage) {
      const extraOptions =
        newStatus === "expired"
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: "Create New Payment", callback_data: "pay" }]],
              },
            }
          : {};

      await bot.telegram.sendMessage(payment.chatId, userMessage, extraOptions);
    }
  }

  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

bot.launch();

setInterval(() => {
  scanPaymentReminders().catch((error) => {
    console.error("Payment reminder scan failed:", error.message);
  });
}, REMINDER_CHECK_MS);

console.log("Telegram bot started");

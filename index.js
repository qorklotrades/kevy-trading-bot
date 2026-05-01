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
const STARTS_FILE = "starts.json";
const DEPOSIT_EXPIRY_MS = 60 * 60 * 1000;
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

function loadStarts() {
  if (!fs.existsSync(STARTS_FILE)) {
    return [];
  }

  const starts = JSON.parse(fs.readFileSync(STARTS_FILE, "utf8"));
  return Array.isArray(starts) ? starts : [];
}

function saveStarts(starts) {
  fs.writeFileSync(STARTS_FILE, JSON.stringify(starts, null, 2));
}

function saveStartClick(ctx) {
  const starts = loadStarts();
  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : "";
  const telegramName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");

  starts.push({
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    username: telegramUsername,
    name: telegramName,
    clickedAt: new Date().toISOString(),
  });

  saveStarts(starts);
}

function getStartStats() {
  const starts = loadStarts();
  const now = Date.now();
  const todayKey = londonDateKey(new Date());
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const todayStarts = starts.filter(
    (start) => start.clickedAt && londonDateKey(start.clickedAt) === todayKey
  );

  const weeklyStarts = starts.filter(
    (start) => start.clickedAt && new Date(start.clickedAt).getTime() >= sevenDaysAgo
  );

  const monthlyStarts = starts.filter(
    (start) => start.clickedAt && new Date(start.clickedAt).getTime() >= thirtyDaysAgo
  );

  const countUniqueUsers = (items) => {
    return new Set(items.map((item) => String(item.userId || item.chatId))).size;
  };

  return {
    totalStarts: starts.length,
    todayStarts: todayStarts.length,
    weeklyStarts: weeklyStarts.length,
    monthlyStarts: monthlyStarts.length,
    totalUniqueUsers: countUniqueUsers(starts),
    todayUniqueUsers: countUniqueUsers(todayStarts),
    weeklyUniqueUsers: countUniqueUsers(weeklyStarts),
    monthlyUniqueUsers: countUniqueUsers(monthlyStarts),
  };
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
    expired: "Payment expired - create a new deposit",
    cancelled: "Payment cancelled",
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
    expired: "Your payment has expired. Please press ▪️ Deposit to create a new deposit.",
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

function paymentBelongsToUser(payment, userId, chatId) {
  return (
    String(payment.chatId) === String(chatId) ||
    String(payment.telegramUserId) === String(userId)
  );
}

function getUserPayments(userId, chatId) {
  const payments = loadPayments();

  return Object.entries(payments).filter(([paymentId, payment]) =>
    paymentBelongsToUser(payment, userId, chatId)
  );
}

function userHasAccess(userId, chatId) {
  return true;
}

function getMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Setup KevyBot", "pay")],
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
      Markup.button.callback("📈 Example Trade Alert", "example_trade_alert"),
      Markup.button.callback("⚠️ Risk Notice", "risk_notice"),
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

function mainMenuReplyMarkup(extraRows = []) {
  return {
    inline_keyboard: [
      ...extraRows,
      [{ text: "⬅️ Main Menu", callback_data: "main_menu" }],
    ],
  };
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

function getLatestDepositEntry(userId, chatId) {
  const deposits = getUserPayments(userId, chatId).filter(
    ([paymentId, payment]) => payment.type === "deposit"
  );

  return deposits.length ? deposits[deposits.length - 1] : null;
}

function getLatestPendingDepositEntry(userId, chatId) {
  const deposits = getUserPayments(userId, chatId).filter(
    ([paymentId, payment]) =>
      payment.type === "deposit" && isActiveUnpaidStatus(payment.status)
  );

  return deposits.length ? deposits[deposits.length - 1] : null;
}

function cancelLatestPendingDeposit(userId, chatId) {
  const payments = loadPayments();

  const pendingDeposits = Object.entries(payments).filter(
    ([paymentId, payment]) =>
      paymentBelongsToUser(payment, userId, chatId) &&
      payment.type === "deposit" &&
      isActiveUnpaidStatus(payment.status)
  );

  if (pendingDeposits.length === 0) {
    return null;
  }

  const [paymentId] = pendingDeposits[pendingDeposits.length - 1];

  payments[paymentId].status = "cancelled";
  payments[paymentId].updatedAt = new Date().toISOString();

  savePayments(payments);

  return [paymentId, payments[paymentId]];
}

function getDepositExpiresAt(payment) {
  if (payment.depositExpiresAt) {
    return payment.depositExpiresAt;
  }

  if (!payment.createdAt) {
    return "";
  }

  return new Date(new Date(payment.createdAt).getTime() + DEPOSIT_EXPIRY_MS).toISOString();
}

function cancelPendingDepositsForUser(userId, chatId) {
  const payments = loadPayments();
  let changed = false;

  for (const [paymentId, payment] of Object.entries(payments)) {
    if (
      paymentBelongsToUser(payment, userId, chatId) &&
      payment.type === "deposit" &&
      isActiveUnpaidStatus(payment.status)
    ) {
      payment.status = "cancelled";
      payment.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    savePayments(payments);
  }
}

async function sendDepositCoinMenu(ctx) {
  await ctx.reply(
    "<b>Please select which crypto currency you would like to deposit funds into your account with.</b>",
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Solana", callback_data: "deposit_coin:sol" }],
        [{ text: "Bitcoin", callback_data: "deposit_coin:btc" }],
        [{ text: "Ethereum", callback_data: "deposit_coin:eth" }],
      ]),
    }
  );
}


function getUserBalanceStats(userId, chatId) {
  const userPayments = getUserPayments(userId, chatId);

  const finishedDeposits = userPayments.filter(
    ([paymentId, payment]) => payment.type === "deposit" && payment.status === "finished"
  );

  const finishedWithdrawals = userPayments.filter(
    ([paymentId, payment]) => payment.type === "withdrawal" && payment.status === "finished"
  );

  const sumUsd = (entries) => {
    return entries.reduce((total, [paymentId, payment]) => {
      const amount = Number.parseFloat(payment.priceAmount || payment.amount || "0");
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  };

  const totalDeposited = sumUsd(finishedDeposits);
  const totalWithdrawn = sumUsd(finishedWithdrawals);

  return {
    accountBalance: totalDeposited - totalWithdrawn,
    totalDeposited,
    totalWithdrawn,
  };
}

function formatDepositStatus(paymentId, payment) {
  return [
    "<b>Deposit Status</b>",
    "",
    `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
    `Status: <b>${escapeHtml(payment.status || "unknown")}</b>`,
    `Status Detail: ${escapeHtml(getStatusExplanation(payment.status))}`,
    `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
    `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
    `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
    `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
  ].join("\n");
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
    "Your deposit is still waiting. Complete it, check the status, or cancel it to create a new one.",
    {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
        [{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }],
      ]),
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
      reply_markup: mainMenuReplyMarkup(),
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
  const startStats = getStartStats();

  const todayEntries = entries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  const depositEntries = entries.filter(
    ([paymentId, payment]) => payment.type === "deposit"
  );

  const todayDepositEntries = depositEntries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  const countStatus = (status) =>
    entries.filter(([paymentId, payment]) => payment.status === status).length;

  await ctx.reply(
    [
      "<b>Bot Stats</b>",
      "",
      "<b>/start Clicks</b>",
      `Today: ${startStats.todayStarts}`,
      `Last 7 Days: ${startStats.weeklyStarts}`,
      `Last 30 Days: ${startStats.monthlyStarts}`,
      `Total: ${startStats.totalStarts}`,
      "",
      "<b>Unique Users</b>",
      `Today: ${startStats.todayUniqueUsers}`,
      `Last 7 Days: ${startStats.weeklyUniqueUsers}`,
      `Last 30 Days: ${startStats.monthlyUniqueUsers}`,
      `Total: ${startStats.totalUniqueUsers}`,
      "",
      "<b>Deposits</b>",
      `Total deposit attempts: ${depositEntries.length}`,
      `Today deposit attempts: ${todayDepositEntries.length}`,
      `Finished: ${countStatus("finished")}`,
      `Waiting: ${countStatus("waiting")}`,
      `Confirming: ${countStatus("confirming")}`,
      `Expired: ${countStatus("expired")}`,
      `Cancelled: ${countStatus("cancelled")}`,
      `Failed: ${countStatus("failed")}`,
      "",
      "<b>Money</b>",
      `Estimated completed deposits: ${calculateRevenue(depositEntries).toFixed(2)} USD`,
      "",
      "<b>Records</b>",
      `Total payment records: ${entries.length}`,
      `Today payment records: ${todayEntries.length}`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
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
    reply_markup: mainMenuReplyMarkup(),
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
      reply_markup: mainMenuReplyMarkup(),
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
    reply_markup: mainMenuReplyMarkup(),
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
    reply_markup: mainMenuReplyMarkup(),
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
    reply_markup: mainMenuReplyMarkup(),
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
    reply_markup: mainMenuReplyMarkup(),
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
  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : "";
  const telegramName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  saveStartClick(ctx);

  await sendAdminMessage(
    [
      "<b>New /start click</b>",
      `User ID: <code>${escapeHtml(ctx.from.id)}</code>`,
      `Chat ID: <code>${escapeHtml(ctx.chat.id)}</code>`,
      `Username: ${escapeHtml(telegramUsername || "none")}`,
      `Name: ${escapeHtml(telegramName || "unknown")}`,
      `Started: ${escapeHtml(formatTimestamp(new Date().toISOString()))}`,
    ].join("\n")
  );

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

bot.action("main_menu", async (ctx) => {
  await ctx.answerCbQuery();

  const menu = getMainMenuKeyboard();

  if (process.env.WELCOME_IMAGE_URL) {
    try {
      await ctx.replyWithPhoto(process.env.WELCOME_IMAGE_URL, {
        caption: "Welcome to Kevy Trading Bot.\n\nYour automated crypto trading assistant built to help you access powerful trading features with a simple one-time setup.\n\nChoose an option below to get started.",
        ...menu,
      });
      return;
    } catch (error) {
      console.error("Could not send welcome image from main menu:", error.message);
    }
  }

  await ctx.reply("Welcome. Choose an option:", menu);
});


bot.action("account", async (ctx) => {
  await ctx.answerCbQuery();

  const payments = getUserPayments(ctx.from.id, ctx.chat.id);
  const latestPayment = payments.length ? payments[payments.length - 1] : null;
  const hasAccess = userHasAccess(ctx.from.id, ctx.chat.id);
  const todayKey = londonDateKey(new Date());
  const balanceStats = getUserBalanceStats(ctx.from.id, ctx.chat.id);

  const tradeEntries = payments.filter(
    ([paymentId, payment]) => payment.type === "trade" || payment.pnl !== undefined || payment.profit !== undefined
  );

  const todayTradeEntries = tradeEntries.filter(
    ([paymentId, payment]) => payment.createdAt && londonDateKey(payment.createdAt) === todayKey
  );

  const calculatePnl = (entries) => {
    return entries.reduce((total, [paymentId, payment]) => {
      const amount = Number.parseFloat(payment.pnl ?? payment.profit ?? "0");
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  };

  const todayPnl = calculatePnl(todayTradeEntries);
  const overallPnl = calculatePnl(tradeEntries);
  const totalTrades = tradeEntries.length;
  const winningTrades = tradeEntries.filter(([paymentId, payment]) => {
    const amount = Number.parseFloat(payment.pnl ?? payment.profit ?? "0");
    return Number.isFinite(amount) && amount > 0;
  }).length;

  const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) : "0.0";

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
      "",
      "<b>💰 Balance</b>",
      "",
      `Account Balance: <b>$${balanceStats.accountBalance.toFixed(2)}</b>`,
      `Total Deposited: <b>$${balanceStats.totalDeposited.toFixed(2)}</b>`,
      `Total Withdrawn: <b>$${balanceStats.totalWithdrawn.toFixed(2)}</b>`,
      "",
      "<b>📈 PnL Tracker</b>",
      "",
      `Today’s PnL: <b>$${todayPnl.toFixed(2)}</b>`,
      `Overall PnL: <b>$${overallPnl.toFixed(2)}</b>`,
      `Total Trades: <b>${totalTrades}</b>`,
      `Winning Trades: <b>${winningTrades}</b>`,
      `Win Rate: <b>${winRate}%</b>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
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
      reply_markup: mainMenuReplyMarkup(),
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
      reply_markup: mainMenuReplyMarkup(),
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
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("faq", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>❓ FAQ</b>",
      "",
      "<b>How do I setup KevyBot?</b>",
      "Press Setup KevyBot and follow the steps shown.",
      "",
      "<b>How do I deposit?</b>",
      "Press ▪️ Deposit, choose Solana, Bitcoin, or Ethereum, then enter the amount you want to deposit.",
      "",
      "<b>What is the minimum deposit?</b>",
      "The minimum deposit is $20.",
      "",
      "<b>How long does payment take?</b>",
      "It depends on the blockchain network. Some payments can take a few minutes.",
      "",
      "<b>What if I send the wrong coin or network?</b>",
      "Contact @qevybtc.",
      "",
      "<b>Can I cancel a pending deposit?</b>",
      "Yes. Press Cancel Pending Deposit before sending funds.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  const pendingDeposit = getLatestPendingDepositEntry(ctx.from.id, ctx.chat.id);

  if (pendingDeposit) {
    const [paymentId, payment] = pendingDeposit;

    await ctx.reply(
      [
        "<b>You already have a pending deposit.</b>",
        "",
        `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
        `Status: <b>${escapeHtml(payment.status || "unknown")}</b>`,
        `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
        "",
        "You can complete it, check the status, or cancel it to create a new one.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: mainMenuReplyMarkup([
          [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
          [{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }],
        ]),
      }
    );
    return;
  }

  await ctx.reply(
    "<b>Please select which crypto currency you would like to deposit funds into your account with.</b>",
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Solana", callback_data: "deposit_coin:sol" }],
        [{ text: "Bitcoin", callback_data: "deposit_coin:btc" }],
        [{ text: "Ethereum", callback_data: "deposit_coin:eth" }],
      ]),
    }
  );
});

bot.action("new_deposit", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    console.error("New deposit button answer error:", error.message);
  }

  try {
    depositSessions.delete(String(ctx.from.id));
    cancelPendingDepositsForUser(ctx.from.id, ctx.chat.id);

    await sendDepositCoinMenu(ctx);
  } catch (error) {
    console.error("New deposit error:", error.message);

    await ctx.reply("Sorry, I could not create a new deposit menu. Please press ▪️ Deposit from the main menu.", {
      reply_markup: mainMenuReplyMarkup(),
    });
  }
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
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    }
  );
});

bot.action("withdraw", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>Please select which way you would like to withdraw your funds.</b>",
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "🏦 Bank Transfer", callback_data: "withdraw_bank" }],
        [{ text: "🪙 Crypto Wallet", callback_data: "withdraw_crypto" }],
      ]),
    }
  );
});

bot.action("withdraw_bank", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>You have $0 funds to withdraw, please deposit using the menu above.</b>",
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("withdraw_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "<b>You have $0 funds to withdraw, please deposit using the menu above.</b>",
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("snipe_bot", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "You have deposited 0 funds into your account, please deposit using the menu above to continue.",
    {
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("bot_filters", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "You have deposited 0 funds into your account, please deposit using the menu above to continue.",
    {
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("example_trade_alert", async (ctx) => {
  await ctx.answerCbQuery();

  const coins = ["SOL", "BTC", "ETH", "DOGE", "PEPE", "BONK", "WIF"];
  const coin = coins[Math.floor(Math.random() * coins.length)];

  const entry = Number((Math.random() * 200 + 0.01).toFixed(4));
  const profitPercent = Number((Math.random() * 18 + 2).toFixed(2));
  const current = Number((entry * (1 + profitPercent / 100)).toFixed(4));
  const estimatedPnl = Number((Math.random() * 120 + 5).toFixed(2));

  await ctx.reply(
    [
      "<b>📈 Example Trade Alert</b>",
      "",
      "Kevy has opened a trade.",
      "",
      `<b>Coin:</b> ${coin}`,
      `<b>Entry:</b> $${entry}`,
      `<b>Current:</b> $${current}`,
      `<b>Profit:</b> +${profitPercent}%`,
      `<b>Estimated PnL:</b> +$${estimatedPnl}`,
      "",
      "You will be alerted when Kevy makes a trade for you and explains how much profit you are in.",
      "",
      "<i>This is a simulation of what Kevy will send you when it enters a trade or when you request information off him. He will talk back to you like a human being and tell you want you want to know about the trade and his thoughts on it.</i>",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("risk_notice", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>⚠️ Risk Notice</b>",
      "",
      "Trading involves risk and results are not guaranteed.",
      "Only deposit funds you are comfortable using.",
      "Crypto prices can move quickly and profits are not promised.",
      "",
      "If you need help, contact @qevybtc.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
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
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("help", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>Help</b>",
      "",
      "Kevy Trading Bot is built to help you deposit funds, track your account, access trading tools like Snipe Bot and Bot Filters, check your payment status, and get support whenever needed.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
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
      "",
      "Please include:",
      "User ID",
      "Payment ID",
      "Issue",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("status", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    console.error("Status button answer error:", error.message);
  }

  try {
    const pendingDeposit = getLatestPendingDepositEntry(ctx.from.id, ctx.chat.id);

    if (!pendingDeposit) {
      const latestDeposit = getLatestDepositEntry(ctx.from.id, ctx.chat.id);
      const depositStatus = latestDeposit
        ? latestDeposit[1].status || "unknown"
        : "never deposited";

      await ctx.reply(
        [
          "<b>My payment status</b>",
          "",
          "<b>You currently don't have any pending deposits. You have either cancelled the deposit, it's expired or you have never created one.</b>",
          "",
          "",
          `<b>Deposit status:</b> ${escapeHtml(depositStatus)}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: mainMenuReplyMarkup([
            [{ text: "Create New Deposit", callback_data: "new_deposit" }],
          ]),
        }
      );
      return;
    }

    const [paymentId, payment] = pendingDeposit;
    const expiresAt = getDepositExpiresAt(payment);
    let expiresText = "not updated yet";

    if (expiresAt) {
      try {
        expiresText = formatTimestamp(expiresAt);
      } catch (error) {
        expiresText = "not updated yet";
      }
    }

    await ctx.reply(
      [
        "<b>My payment status</b>",
        "",
        "<b>Latest pending deposit:</b>",
        `<b>Payment ID:</b> <code>${escapeHtml(paymentId)}</code>`,
        `<b>Coin:</b> ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `<b>Status:</b> ${escapeHtml(payment.status || "unknown")}`,
        `<b>Status Detail:</b> ${escapeHtml(getStatusExplanation(payment.status))}`,
        `<b>Amount:</b> ${escapeHtml(payment.payAmount || "unknown")}`,
        `<b>Address:</b> <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
        `<b>Expires:</b> ${escapeHtml(expiresText)}`,
        `<b>Created:</b> ${escapeHtml(formatTimestamp(payment.createdAt))}`,
        `<b>Updated:</b> ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: mainMenuReplyMarkup([
          [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
          [{ text: "Create New Deposit", callback_data: "new_deposit" }],
          [{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }],
        ]),
      }
    );
  } catch (error) {
    console.error("My Payment Status error:", error.message);

    await ctx.reply("Sorry, I could not load your payment status. Please try again.", {
      reply_markup: mainMenuReplyMarkup(),
    });
  }
});



bot.action("pay", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>📕 How to setup KevyBot</b>",
      "",
      "1️⃣ Press the ▪️Deposit button to deposit funds into your account",
      "",
      "2️⃣ Pick your preset of filters in ✨ Bot Filters",
      "",
      "3️⃣ Let Kevy run in the backround while you enjoy your day",
      "",
      "4️⃣ You will be alerted when Kevy makes a trade for you and explains how much profit you are in.",
      "",
      "5️⃣ Withdraw using the ▫️ Withdraw button and selecting which way you would like to recieve your funds.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action(/^coin:(btc|eth|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("This payment option is no longer available. Please use ▪️ Deposit instead.", {
    reply_markup: mainMenuReplyMarkup(),
  });
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
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("cancel_deposit", async (ctx) => {
  await ctx.answerCbQuery();

  depositSessions.delete(String(ctx.from.id));

  const cancelledDeposit = cancelLatestPendingDeposit(ctx.from.id, ctx.chat.id);

  if (!cancelledDeposit) {
    await ctx.reply(
      "Deposit cancelled. You do not have any pending deposit waiting.",
      {
        reply_markup: mainMenuReplyMarkup(),
      }
    );
    return;
  }

  const [paymentId, payment] = cancelledDeposit;

  await ctx.reply(
    [
      "<b>Pending deposit cancelled.</b>",
      "",
      `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
      "",
      "You can now create a new deposit.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Create New Deposit", callback_data: "deposit" }],
      ]),
    }
  );
});

bot.action("check_deposit_status", async (ctx) => {
  await ctx.answerCbQuery();

  const latestDeposit = getLatestDepositEntry(ctx.from.id, ctx.chat.id);

  if (!latestDeposit) {
    await ctx.reply("You do not have any deposits yet.", {
      reply_markup: mainMenuReplyMarkup(),
    });
    return;
  }

  const [paymentId, payment] = latestDeposit;
  const buttons = [];

  if (isActiveUnpaidStatus(payment.status)) {
    buttons.push([{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }]);
  }

  if (payment.status === "Expired" || payment.status === "Cancelled") {
    buttons.push([{ text: "Create New Deposit", callback_data: "deposit" }]);
  }

  await ctx.reply(formatDepositStatus(paymentId, payment), {
    parse_mode: "HTML",
    reply_markup: mainMenuReplyMarkup(buttons),
  });
});

bot.on("text", async (ctx, next) => {
  const session = depositSessions.get(String(ctx.from.id));

  if (!session) {
    return next();
  }

  const amountText = ctx.message.text.replace(/[$,]/g, "").trim();
  const amount = Number.parseFloat(amountText);

  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Please enter a valid deposit amount. Example: $50", {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    });
    return;
  }

  if (amount < 20) {
    await ctx.reply("Minimum deposit amount is 20 USD. Please enter a higher amount.", {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    });
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
        "<b>Deposit Instructions</b>",
        "",
        `Only send ${COINS[coin]} to this address.`,
        "Do not send from the wrong network.",
        "Deposits under $20 will not be credited.",
        "",
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
        reply_markup: mainMenuReplyMarkup([
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
      text: "Copy Amount",
      copy_text: {
        text: payment.pay_amount ? String(payment.pay_amount) : String(amount),
      },
    },
  ],
  [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
  [{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }],
  [{ text: "How to buy crypto (easy)", callback_data: "how_to_buy_crypto_easy" }],
]),

      }
    );
  } catch (error) {
    console.error(error.response?.data || error.message);
    await ctx.reply("Sorry, I could not create the deposit. Please try again.", {
      reply_markup: mainMenuReplyMarkup(),
    });
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
      "Welcome, you now have access to Kevy The Trading Bot. Please contact @qevybtc to get started.",
      {
        reply_markup: mainMenuReplyMarkup(),
      }
    );
  }

  if (newStatus !== "finished" && newStatus !== previousStatus) {
    const userMessage = getUserStatusMessage(newStatus);

    if (userMessage) {
      const extraButtons =
        newStatus === "expired"
          ? [[{ text: "Create New Deposit", callback_data: "deposit" }]]
          : [];

      await bot.telegram.sendMessage(payment.chatId, userMessage, {
        reply_markup: mainMenuReplyMarkup(extraButtons),
      });
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

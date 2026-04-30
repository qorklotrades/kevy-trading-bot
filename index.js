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

bot.command("transactions", async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
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
      return [
        `<b>${index + 1}. Transaction</b>`,
        `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
        `Status: <b>${escapeHtml(payment.status || "unknown")}</b>`,
        `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
        `Address: <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
        `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
        `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
        `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
        `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
        `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
      ].join("\n");
    })
    .join("\n\n");

  await ctx.reply(message, {
    parse_mode: "HTML",
  });
});

bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome. Choose an option:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Get Access", "pay")],
      [Markup.button.callback("My Payment Status", "status")],
      [
        Markup.button.callback("▪️ Deposit", "deposit"),
        Markup.button.callback("▫️ Withdraw", "withdraw"),
      ],
      [
        Markup.button.callback("👥 Help", "help"),
        Markup.button.callback("📕 Support", "support"),
      ],
      [Markup.button.callback("💠 How To Buy Crypto", "how_to_buy_crypto")],
    ])
  );
});

bot.action("deposit", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("Loading...");
  await wait(1000);

  await ctx.reply(
    "You have not purchased Kevy, once you have done so by pressing Get Access, you will be able to use the following features."
  );
});

bot.action("withdraw", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("Loading...");
  await wait(1000);

  await ctx.reply(
    "You have not purchased Kevy, once you have done so by pressing Get Access, you will be able to use the following features."
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

  const payments = loadPayments();
  const userPayments = Object.entries(payments).filter(
    ([paymentId, payment]) => String(payment.chatId) === String(ctx.chat.id)
  );

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

  await ctx.reply(
    [
      "<b>My payment status</b>",
      "",
      "Latest payment:",
      `Payment ID: ${escapeHtml(paymentId)}`,
      `Coin: ${escapeHtml(payment.coin.toUpperCase())}`,
      `Status: ${escapeHtml(payment.status)}`,
      `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
      `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.action("pay", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    "Choose which crypto you want to pay with:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Bitcoin", "coin:btc")],
      [Markup.button.callback("Ethereum", "coin:eth")],
      [Markup.button.callback("Solana", "coin:sol")],
    ])
  );
});

bot.action(/^coin:(btc|eth|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const coin = ctx.match[1];
  const chatId = ctx.chat.id;
  const orderId = `tg_${chatId}_${Date.now()}`;
  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : "";
  const telegramName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");

  await ctx.reply(`Creating your ${COINS[coin]} payment...`);

  try {
    const response = await axios.post(
      `${process.env.NOWPAYMENTS_BASE_URL}/payment`,
      {
        price_amount: process.env.PRICE_AMOUNT,
        price_currency: process.env.PRICE_CURRENCY,
        pay_currency: coin,
        ipn_callback_url: `${process.env.PUBLIC_BASE_URL}/nowpayments-ipn`,
        order_id: orderId,
        order_description: `Telegram payment from user ${chatId}`,
      },
      {
        headers: {
          "x-api-key": process.env.NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const payment = response.data;

    console.log("NOWPayments response:");
    console.log(JSON.stringify(payment, null, 2));

    if (!payment.payment_id || !payment.pay_address) {
      await ctx.reply("Payment was created, but no wallet address was returned. Check the VS Code terminal.");
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
      status: "waiting",
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount ? `${payment.pay_amount} ${coin.toUpperCase()}` : "",
      priceAmount: process.env.PRICE_AMOUNT,
      priceCurrency: process.env.PRICE_CURRENCY,
      createdAt: new Date().toISOString(),
      updatedAt: "",
    };

    savePayments(payments);

    await ctx.reply(
      [
        `<b>Send ${COINS[coin]} payment to this address:</b>`,
        "",
        `<code>${escapeHtml(payment.pay_address)}</code>`,
        "",
        payment.pay_amount
          ? `<b>Amount:</b> <code>${payment.pay_amount} ${coin.toUpperCase()}</code>`
          : `<b>Amount:</b> ${process.env.PRICE_AMOUNT} ${process.env.PRICE_CURRENCY.toUpperCase()} worth of ${coin.toUpperCase()}`,
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
    await ctx.reply("Sorry, I could not create the payment. Please try again.");
  }
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

  payment.status = payment_status;
  payment.updatedAt = new Date().toISOString();
  payment.nowpaymentsStatus = payment_status;
  payment.actuallyPaid = req.body.actually_paid || "";
  payment.outcomeAmount = req.body.outcome_amount || "";
  payment.outcomeCurrency = req.body.outcome_currency || "";

  savePayments(payments);

  if (payment_status === "finished") {
    await bot.telegram.sendMessage(
      payment.chatId,
      "Welcome, you now have access to Kevy The Trading Bot. Please contact @qevybtc to get started."
    );
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

console.log("Telegram bot started");

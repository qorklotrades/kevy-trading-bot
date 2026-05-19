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
const BLACKLIST_FILE = "blacklist.json";
const DEPOSIT_EXPIRY_MS = 60 * 60 * 1000;
const PAYMENT_COOLDOWN_MS = 30 * 1000;
const PAYMENT_REMINDER_MS = 30 * 60 * 1000;
const REMINDER_CHECK_MS = 5 * 60 * 1000;
const DISPLAY_CURRENCY_CODE = "GBP";
const DISPLAY_CURRENCY_SYMBOL = "Â£";

const paymentCooldowns = new Map();
const depositSessions = new Map();
const verificationSessions = new Map();

const COINS = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
};

const DEPOSIT_ADDRESSES = {
  sol: "77UEYo3aRwk9mBKcnhRFTxaXSFTzjwpv3uTpHivfrS4h",
  eth: "0x0a4675Db602Db1C3cA07E2652C5f281B470672e8",
  btc: "bc1q444yx2jscgq905x30h5w4muwnhxdm4hmjt6fra",
};

const NETWORK_WARNINGS = {
  sol: "Only send SOL on the Solana network.",
  eth: "Only send ETH on the Ethereum ERC-20 network.",
  btc: "Only send BTC on the Bitcoin network.",
};

const EXPLORER_LINKS = {
  sol: "https://solscan.io/tx/",
  eth: "https://etherscan.io/tx/",
  btc: "https://blockstream.info/tx/",
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

function loadBlacklist() {
  if (!fs.existsSync(BLACKLIST_FILE)) {
    return [];
  }

  const blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  return Array.isArray(blacklist) ? blacklist.map(String) : [];
}

function saveBlacklist(blacklist) {
  fs.writeFileSync(
    BLACKLIST_FILE,
    JSON.stringify([...new Set(blacklist.map(String))], null, 2)
  );
}

function isBlacklisted(userId) {
  return loadBlacklist().includes(String(userId));
}

function addToBlacklist(userId) {
  const blacklist = loadBlacklist();

  if (!blacklist.includes(String(userId))) {
    blacklist.push(String(userId));
  }

  saveBlacklist(blacklist);
}

function removeFromBlacklist(userId) {
  const blacklist = loadBlacklist();
  const nextBlacklist = blacklist.filter((item) => String(item) !== String(userId));
  saveBlacklist(nextBlacklist);

  return blacklist.length !== nextBlacklist.length;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
    rejected: "Payment rejected - contact support @qevybtc",
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
    rejected: "Your deposit could not be approved. Please contact @qevybtc.",
    failed: "Your payment failed. Please contact @qevybtc.",
    expired: "Your payment has expired. Please press â–ªï¸ Deposit to create a new deposit.",
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

function isActiveUnpaidStatus(status) {
  return ["waiting", "confirming", "confirmed", "sending"].includes(
    String(status || "").toLowerCase()
  );
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

function formatTimeRemaining(value) {
  if (!value) {
    return "not updated yet";
  }

  const remainingMs = new Date(value).getTime() - Date.now();

  if (remainingMs <= 0) {
    return "expired";
  }

  const totalMinutes = Math.ceil(remainingMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

function expireOldPendingDeposits() {
  const payments = loadPayments();
  let changed = false;
  const now = Date.now();

  for (const [paymentId, payment] of Object.entries(payments)) {
    if (payment.type !== "deposit" || !isActiveUnpaidStatus(payment.status)) {
      continue;
    }

    const expiresAt = getDepositExpiresAt(payment);

    if (expiresAt && new Date(expiresAt).getTime() <= now) {
      payments[paymentId].status = "expired";
      payments[paymentId].updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    savePayments(payments);
  }
}

function getUserPayments(userId, chatId) {
  expireOldPendingDeposits();

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
      Markup.button.callback("â–ªï¸ Deposit", "deposit"),
      Markup.button.callback("â–«ï¸ Withdraw", "withdraw"),
    ],
    [
      Markup.button.callback("ðŸŽ¯ Snipe Bot", "snipe_bot"),
      Markup.button.callback("âœ¨ Bot Filters", "bot_filters"),
    ],
    [
      Markup.button.callback("ðŸ“ˆ Example Trade Alert", "example_trade_alert"),
      Markup.button.callback("âš ï¸ Risk Notice", "risk_notice"),
    ],
    [
      Markup.button.callback("ðŸ§‘â€ðŸ« New To Crypto?", "new_to_crypto"),
      Markup.button.callback("ðŸ“˜ Deposit Guide", "deposit_guide"),
    ],
    [
      Markup.button.callback("ðŸ“Š Account", "account"),
      Markup.button.callback("ðŸŽ Referral", "referral"),
    ],
    [
      Markup.button.callback("ðŸ‘¥ Help", "help"),
      Markup.button.callback("ðŸ“• Support", "support"),
    ],
    [
      Markup.button.callback("ðŸ“Œ Terms", "terms"),
      Markup.button.callback("ðŸ”” Updates", "updates"),
    ],
    [Markup.button.callback("â“ FAQ", "faq")],
    [Markup.button.callback("ðŸ’  How To Buy Crypto", "how_to_buy_crypto")],
  ]);
}

function mainMenuReplyMarkup(extraRows = []) {
  return {
    inline_keyboard: [
      ...extraRows,
      [{ text: "â¬…ï¸ Main Menu", callback_data: "main_menu" }],
    ],
  };
}

async function sendWelcomeMenu(ctx) {
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
    payment.txHash ? `TX Hash: <code>${escapeHtml(payment.txHash)}</code>` : "",
    `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
    `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
    `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
    `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
    `Updated: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
  ].filter(Boolean).join("\n");
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
      const amount = Number.parseFloat(payment.priceAmount || "0");
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
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

function transactionHashAlreadyUsed(txHash, currentPaymentId) {
  const payments = loadPayments();
  const cleanTxHash = String(txHash || "").trim().toLowerCase();

  return Object.entries(payments).some(([paymentId, payment]) => {
    return (
      paymentId !== currentPaymentId &&
      String(payment.txHash || "").trim().toLowerCase() === cleanTxHash
    );
  });
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

  const sumAmount = (entries) => {
    return entries.reduce((total, [paymentId, payment]) => {
      const amount = Number.parseFloat(payment.priceAmount || payment.amount || "0");
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  };

  const totalDeposited = sumAmount(finishedDeposits);
  const totalWithdrawn = sumAmount(finishedWithdrawals);

  return {
    accountBalance: totalDeposited - totalWithdrawn,
    totalDeposited,
    totalWithdrawn,
  };
}

function formatDepositStatus(paymentId, payment) {
  const expiresAt = getDepositExpiresAt(payment);

  return [
    "<b>Deposit Status</b>",
    "",
    `<b>Payment ID:</b> <code>${escapeHtml(paymentId)}</code>`,
    `<b>Status:</b> ${escapeHtml(payment.status || "unknown")}`,
    `<b>Status Detail:</b> ${escapeHtml(getStatusExplanation(payment.status))}`,
    `<b>Coin:</b> ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
    `<b>Amount:</b> ${escapeHtml(payment.payAmount || "unknown")}`,
    `<b>Address:</b> <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
    payment.txHash ? `<b>TX Hash:</b> <code>${escapeHtml(payment.txHash)}</code>` : "",
    `<b>Expires:</b> ${escapeHtml(expiresAt ? formatTimestamp(expiresAt) : "not updated yet")}`,
    `<b>Expires in:</b> ${escapeHtml(formatTimeRemaining(expiresAt))}`,
    `<b>Created:</b> ${escapeHtml(formatTimestamp(payment.createdAt))}`,
    `<b>Updated:</b> ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
  ].filter(Boolean).join("\n");
}

function getDepositButtons(payment) {
  const buttons = [];

  if (payment.payAddress) {
    buttons.push([
      {
        text: "Copy address",
        copy_text: {
          text: payment.payAddress,
        },
      },
    ]);
  }

  if (payment.priceAmount) {
    buttons.push([
      {
        text: "Copy Amount",
        copy_text: {
          text: String(payment.priceAmount),
        },
      },
    ]);
  }

  if (isActiveUnpaidStatus(payment.status)) {
    buttons.push([{ text: "I Have Paid", callback_data: "submit_tx_hash" }]);
    buttons.push([{ text: "Check Deposit Status", callback_data: "check_deposit_status" }]);
    buttons.push([{ text: "Create New Deposit", callback_data: "new_deposit" }]);
    buttons.push([{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }]);
  }

  if (["expired", "cancelled", "rejected", "failed"].includes(String(payment.status || "").toLowerCase())) {
    buttons.push([{ text: "Create New Deposit", callback_data: "new_deposit" }]);
  }

  buttons.push([{ text: "Deposit Guide", callback_data: "deposit_guide" }]);
  buttons.push([{ text: "How to buy crypto (easy)", callback_data: "how_to_buy_crypto_easy" }]);

  return buttons;
}

function getDepositGuideLines(coin) {
  const coinText = coin && COINS[coin] ? COINS[coin] : "crypto";
  const warning = coin && NETWORK_WARNINGS[coin] ? NETWORK_WARNINGS[coin] : "Always use the correct coin and network.";

  return [
    "<b>ðŸ“˜ Deposit Guide</b>",
    "",
    "1. Copy the wallet address.",
    `2. Open your wallet or exchange and choose ${coinText}.`,
    "3. Paste the wallet address carefully.",
    "4. Enter the deposit amount.",
    `5. ${warning}`,
    "6. Send the payment.",
    "7. Come back here and press I Have Paid.",
    "8. Paste your transaction hash so Kevy can verify it.",
    "",
    "<b>Important:</b>",
    "Keep your Payment ID safe. You may need it for support.",
  ];
}

async function verifySolanaTransaction(txHash, expectedAddress) {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const response = await axios.post(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        txHash,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    },
    {
      timeout: 15000,
    }
  );

  const transaction = response.data && response.data.result;

  if (!transaction) {
    return {
      ok: false,
      detail: "Transaction was not found or is not confirmed yet.",
    };
  }

  if (transaction.meta && transaction.meta.err) {
    return {
      ok: false,
      detail: "Transaction exists but failed on-chain.",
    };
  }

  const accountKeys = transaction.transaction.message.accountKeys || [];
  const keyIndex = accountKeys.findIndex((key) => {
    const pubkey = typeof key === "string" ? key : key.pubkey;
    return String(pubkey) === String(expectedAddress);
  });

  if (keyIndex === -1) {
    return {
      ok: false,
      detail: "Transaction was not sent to the Kevy Solana deposit address.",
    };
  }

  const preBalance = Number(transaction.meta.preBalances[keyIndex] || 0);
  const postBalance = Number(transaction.meta.postBalances[keyIndex] || 0);
  const lamportsReceived = postBalance - preBalance;

  if (lamportsReceived <= 0) {
    return {
      ok: false,
      detail: "Transaction did not increase the Kevy Solana deposit address balance.",
    };
  }

  return {
    ok: true,
    amount: lamportsReceived / 1_000_000_000,
    currency: "SOL",
    detail: "Solana transaction verified.",
  };
}

async function verifyEthereumTransaction(txHash, expectedAddress) {
  const apiKey = process.env.ETHERSCAN_API_KEY || "";
  const apiUrl = process.env.ETHERSCAN_API_URL || "https://api.etherscan.io/v2/api";
  const chainId = process.env.ETHERSCAN_CHAIN_ID || "1";
  const transactionResponse = await axios.get(apiUrl, {
    timeout: 15000,
    params: {
      chainid: chainId,
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: txHash,
      apikey: apiKey,
    },
  });

  const transaction = transactionResponse.data && transactionResponse.data.result;

  if (!transaction) {
    return {
      ok: false,
      detail: "Ethereum transaction was not found.",
    };
  }

  if (String(transaction.to || "").toLowerCase() !== String(expectedAddress).toLowerCase()) {
    return {
      ok: false,
      detail: "Transaction was not sent to the Kevy Ethereum deposit address.",
    };
  }

  const receiptResponse = await axios.get(apiUrl, {
    timeout: 15000,
    params: {
      chainid: chainId,
      module: "proxy",
      action: "eth_getTransactionReceipt",
      txhash: txHash,
      apikey: apiKey,
    },
  });

  const receipt = receiptResponse.data && receiptResponse.data.result;

  if (!receipt || !receipt.blockNumber) {
    return {
      ok: false,
      detail: "Ethereum transaction is not confirmed yet.",
    };
  }

  if (receipt.status && receipt.status !== "0x1") {
    return {
      ok: false,
      detail: "Ethereum transaction exists but failed on-chain.",
    };
  }

  const valueWei = BigInt(transaction.value || "0x0");

  if (valueWei <= 0n) {
    return {
      ok: false,
      detail: "Ethereum transaction did not send any ETH.",
    };
  }

  const whole = valueWei / 1_000_000_000_000_000_000n;
  const fraction = valueWei % 1_000_000_000_000_000_000n;
  const amount = Number(`${whole}.${fraction.toString().padStart(18, "0").slice(0, 8)}`);

  return {
    ok: true,
    amount,
    currency: "ETH",
    detail: "Ethereum transaction verified.",
  };
}

async function verifyBitcoinTransaction(txHash, expectedAddress) {
  const apiUrl = process.env.BLOCKSTREAM_API_URL || "https://blockstream.info/api";
  const response = await axios.get(`${apiUrl}/tx/${encodeURIComponent(txHash)}`, {
    timeout: 15000,
  });

  const transaction = response.data;

  if (!transaction || !Array.isArray(transaction.vout)) {
    return {
      ok: false,
      detail: "Bitcoin transaction was not found.",
    };
  }

  if (!transaction.status || !transaction.status.confirmed) {
    return {
      ok: false,
      detail: "Bitcoin transaction is not confirmed yet.",
    };
  }

  const receivedSats = transaction.vout.reduce((total, output) => {
    if (String(output.scriptpubkey_address || "") === String(expectedAddress)) {
      return total + Number(output.value || 0);
    }

    return total;
  }, 0);

  if (receivedSats <= 0) {
    return {
      ok: false,
      detail: "Transaction was not sent to the Kevy Bitcoin deposit address.",
    };
  }

  return {
    ok: true,
    amount: receivedSats / 100_000_000,
    currency: "BTC",
    detail: "Bitcoin transaction verified.",
  };
}

async function verifyBlockchainTransaction(coin, txHash, expectedAddress) {
  if (coin === "sol") {
    return verifySolanaTransaction(txHash, expectedAddress);
  }

  if (coin === "eth") {
    return verifyEthereumTransaction(txHash, expectedAddress);
  }

  if (coin === "btc") {
    return verifyBitcoinTransaction(txHash, expectedAddress);
  }

  return {
    ok: false,
    detail: "Unsupported coin.",
  };
}

async function sendPaymentReminderIfNeeded(paymentId) {
  expireOldPendingDeposits();

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
        [{ text: "I Have Paid", callback_data: "submit_tx_hash" }],
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
  if (!receivedSignature || !process.env.NOWPAYMENTS_IPN_SECRET) {
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

bot.use(async (ctx, next) => {
  if (!ctx.from) {
    return next();
  }

  if (String(ctx.from.id) === String(process.env.ADMIN_TELEGRAM_ID)) {
    return next();
  }

  if (!isBlacklisted(ctx.from.id)) {
    return next();
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("You are blocked from using this bot.");
    return;
  }

  if (ctx.message) {
    await ctx.reply("You are blocked from using this bot.");
    return;
  }
});

bot.command("myid", async (ctx) => {
  await ctx.reply(`Your Telegram ID is: ${ctx.from.id}`);
});

bot.command("blacklist", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    await ctx.reply("Use it like this: /blacklist USER_ID");
    return;
  }

  addToBlacklist(userId);

  await ctx.reply(
    [
      "<b>User blacklisted</b>",
      "",
      `User ID: <code>${escapeHtml(userId)}</code>`,
      "This user can no longer use the bot.",
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.command("unblacklist", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const userId = ctx.message.text.split(" ")[1];

  if (!userId) {
    await ctx.reply("Use it like this: /unblacklist USER_ID");
    return;
  }

  const removed = removeFromBlacklist(userId);

  await ctx.reply(
    removed
      ? `User ${userId} has been removed from the blacklist.`
      : `User ${userId} was not blacklisted.`
  );
});

bot.command("blacklistlist", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const blacklist = loadBlacklist();

  if (blacklist.length === 0) {
    await ctx.reply("No blacklisted users.");
    return;
  }

  await ctx.reply(
    [
      "<b>Blacklisted Users</b>",
      "",
      ...blacklist.map((userId, index) => `${index + 1}. <code>${escapeHtml(userId)}</code>`),
    ].join("\n"),
    {
      parse_mode: "HTML",
    }
  );
});

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const paymentId = ctx.message.text.split(" ")[1];

  if (!paymentId) {
    await ctx.reply("Use it like this: /confirm PAYMENT_ID");
    return;
  }

  const payments = loadPayments();
  const payment = payments[paymentId];

  if (!payment) {
    await ctx.reply("Payment not found.");
    return;
  }

  payment.status = "finished";
  payment.updatedAt = new Date().toISOString();
  payment.actuallyPaid = payment.actuallyPaid || `${DISPLAY_CURRENCY_SYMBOL}${payment.priceAmount || "unknown"}`;
  payment.adminCompletionAlertSentAt = new Date().toISOString();

  savePayments(payments);

  await sendAdminMessage(
    [
      "<b>âœ… Manual deposit confirmed</b>",
      "",
      `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
      `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
      `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
      `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
      `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
      `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
      `Address: <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
      `Completed: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
    ].join("\n")
  );

  await bot.telegram.sendMessage(
    payment.chatId,
    "Your deposit has been confirmed. Your account has been updated.",
    {
      reply_markup: mainMenuReplyMarkup(),
    }
  );

  await ctx.reply("Deposit confirmed.");
});

bot.command("reject", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  const paymentId = ctx.message.text.split(" ")[1];

  if (!paymentId) {
    await ctx.reply("Use it like this: /reject PAYMENT_ID");
    return;
  }

  const payments = loadPayments();
  const payment = payments[paymentId];

  if (!payment) {
    await ctx.reply("Payment not found.");
    return;
  }

  payment.status = "rejected";
  payment.updatedAt = new Date().toISOString();

  savePayments(payments);

  await bot.telegram.sendMessage(
    payment.chatId,
    "Your deposit could not be verified. Please contact @qevybtc if you need help.",
    {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Create New Deposit", callback_data: "new_deposit" }],
      ]),
    }
  );

  await ctx.reply("Deposit rejected.");
});

bot.command("pending", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("You are not allowed to use this command.");
    return;
  }

  expireOldPendingDeposits();

  const payments = loadPayments();
  const pendingEntries = Object.entries(payments).filter(
    ([paymentId, payment]) => payment.type === "deposit" && isActiveUnpaidStatus(payment.status)
  );

  if (pendingEntries.length === 0) {
    await ctx.reply("No pending deposits.");
    return;
  }

  const latestPending = pendingEntries.slice(-15);

  await ctx.reply(
    latestPending.map(([paymentId, payment], index) => {
      return [
        `<b>${index + 1}. Pending Deposit</b>`,
        `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
        `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
        `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
        `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
        `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
        `Address: <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
        `Expires in: ${escapeHtml(formatTimeRemaining(getDepositExpiresAt(payment)))}`,
        payment.txHash ? `TX Hash: <code>${escapeHtml(payment.txHash)}</code>` : "",
        `Created: ${escapeHtml(formatTimestamp(payment.createdAt))}`,
      ].filter(Boolean).join("\n");
    }).join("\n\n"),
    {
      parse_mode: "HTML",
    }
  );
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
      "<code>/blacklist USER_ID</code> - Blocks a user from using the bot",
      "<code>/unblacklist USER_ID</code> - Removes a user from the blacklist",
      "<code>/blacklistlist</code> - Shows blacklisted users",
      "<code>/pending</code> - Shows pending deposits",
      "<code>/confirm PAYMENT_ID</code> - Manually confirms a deposit",
      "<code>/reject PAYMENT_ID</code> - Rejects a deposit",
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

  expireOldPendingDeposits();

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
      `Rejected: ${countStatus("rejected")}`,
      `Failed: ${countStatus("failed")}`,
      "",
      "<b>Money</b>",
      `Estimated completed deposits: ${DISPLAY_CURRENCY_SYMBOL}${calculateRevenue(depositEntries).toFixed(2)} ${DISPLAY_CURRENCY_CODE}`,
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

  expireOldPendingDeposits();

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

  expireOldPendingDeposits();

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
      `Today: ${DISPLAY_CURRENCY_SYMBOL}${calculateRevenue(todayEntries).toFixed(2)} ${DISPLAY_CURRENCY_CODE}`,
      `Total: ${DISPLAY_CURRENCY_SYMBOL}${calculateRevenue(entries).toFixed(2)} ${DISPLAY_CURRENCY_CODE}`,
      "",
      "Revenue is estimated from finished payments using your configured deposit amount.",
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

  expireOldPendingDeposits();

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

  expireOldPendingDeposits();

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

  expireOldPendingDeposits();

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

  expireOldPendingDeposits();

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

  await sendWelcomeMenu(ctx);
});

bot.action("main_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendWelcomeMenu(ctx);
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
      "<b>ðŸ“Š Account</b>",
      "",
      `User ID: <code>${escapeHtml(ctx.from.id)}</code>`,
      `Username: ${escapeHtml(ctx.from.username ? `@${ctx.from.username}` : "none")}`,
      `Access: ${hasAccess ? "Active" : "Not active"}`,
      latestPayment ? `Latest Payment ID: <code>${escapeHtml(latestPayment[0])}</code>` : "Latest Payment ID: none",
      latestPayment ? `Latest Status: ${escapeHtml(latestPayment[1].status || "unknown")}` : "Latest Status: none",
      latestPayment ? `Created: ${escapeHtml(formatTimestamp(latestPayment[1].createdAt))}` : "Created: not updated yet",
      "",
      "<b>ðŸ’° Balance</b>",
      "",
      `Account Balance: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.accountBalance.toFixed(2)}</b>`,
      `Total Deposited: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.totalDeposited.toFixed(2)}</b>`,
      `Total Withdrawn: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.totalWithdrawn.toFixed(2)}</b>`,
      "",
      "<b>ðŸ“ˆ PnL Tracker</b>",
      "",
      `Todayâ€™s PnL: <b>${DISPLAY_CURRENCY_SYMBOL}${todayPnl.toFixed(2)}</b>`,
      `Overall PnL: <b>${DISPLAY_CURRENCY_SYMBOL}${overallPnl.toFixed(2)}</b>`,
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
      "<b>ðŸŽ Referral</b>",
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
      "<b>ðŸ“Œ Terms</b>",
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
      "<b>ðŸ”” Updates</b>",
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
      "<b>â“ FAQ</b>",
      "",
      "<b>How do I setup KevyBot?</b>",
      "Press Setup KevyBot and follow the steps shown.",
      "",
      "<b>How do I deposit?</b>",
      "Press â–ªï¸ Deposit, choose Solana, Bitcoin, or Ethereum, then enter the amount you want to deposit.",
      "",
      "<b>What is the minimum deposit?</b>",
      `The minimum deposit is ${DISPLAY_CURRENCY_SYMBOL}20.`,
      "",
      "<b>How do I verify a deposit?</b>",
      "Press I Have Paid and paste your transaction hash.",
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
    const expiresAt = getDepositExpiresAt(payment);

    await ctx.reply(
      [
        "<b>You already have a pending deposit.</b>",
        "",
        `<b>Payment ID:</b> <code>${escapeHtml(paymentId)}</code>`,
        `<b>Status:</b> ${escapeHtml(payment.status || "unknown")}`,
        `<b>Coin:</b> ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `<b>Amount:</b> ${escapeHtml(payment.payAmount || "unknown")}`,
        `<b>Address:</b> <code>${escapeHtml(payment.payAddress || "unknown")}</code>`,
        `<b>Expires:</b> ${escapeHtml(expiresAt ? formatTimestamp(expiresAt) : "not updated yet")}`,
        `<b>Expires in:</b> ${escapeHtml(formatTimeRemaining(expiresAt))}`,
        "",
        "You can complete it, verify it, check the status, or cancel it to create a new one.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: mainMenuReplyMarkup(getDepositButtons(payment)),
      }
    );
    return;
  }

  await sendDepositCoinMenu(ctx);
});

bot.action("new_deposit", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    console.error("New deposit button answer error:", error.message);
  }

  try {
    depositSessions.delete(String(ctx.from.id));
    verificationSessions.delete(String(ctx.from.id));
    cancelPendingDepositsForUser(ctx.from.id, ctx.chat.id);

    await sendDepositCoinMenu(ctx);
  } catch (error) {
    console.error("New deposit error:", error.message);

    await ctx.reply("Sorry, I could not create a new deposit menu. Please press â–ªï¸ Deposit from the main menu.", {
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
  verificationSessions.delete(String(ctx.from.id));

  await ctx.reply(
    [
      `<b>Please enter the amount you would like to deposit in GBP using ${COINS[coin]}</b>`,
      "",
      "Your deposit will expire in 60 minutes.",
      NETWORK_WARNINGS[coin],
      "",
      `The minimum amount to deposit is ${DISPLAY_CURRENCY_SYMBOL}20, anything under that will be voided and you will not recieve it in your wallet.`,
      "",
      `<b>Example: ${DISPLAY_CURRENCY_SYMBOL}50</b>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Deposit Guide", callback_data: `deposit_guide:${coin}` }],
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    }
  );
});

bot.action("withdraw", async (ctx) => {
  await ctx.answerCbQuery();

  const balanceStats = getUserBalanceStats(ctx.from.id, ctx.chat.id);

  await ctx.reply(
    [
      "<b>Please select which way you would like to withdraw your funds.</b>",
      "",
      `Available balance: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.accountBalance.toFixed(2)}</b>`,
      "",
      "Withdrawals are reviewed manually for account safety.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "ðŸ¦ Bank Transfer", callback_data: "withdraw_bank" }],
        [{ text: "ðŸª™ Crypto Wallet", callback_data: "withdraw_crypto" }],
      ]),
    }
  );
});

bot.action("withdraw_bank", async (ctx) => {
  await ctx.answerCbQuery();

  const balanceStats = getUserBalanceStats(ctx.from.id, ctx.chat.id);

  await ctx.reply(
    [
      "<b>ðŸ¦ Bank Transfer Withdrawal</b>",
      "",
      `Available balance: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.accountBalance.toFixed(2)}</b>`,
      "",
      "Withdrawals are currently reviewed manually.",
      "Please contact @qevybtc and include your User ID, withdrawal method, and requested amount.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action("withdraw_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  const balanceStats = getUserBalanceStats(ctx.from.id, ctx.chat.id);

  await ctx.reply(
    [
      "<b>ðŸª™ Crypto Wallet Withdrawal</b>",
      "",
      `Available balance: <b>${DISPLAY_CURRENCY_SYMBOL}${balanceStats.accountBalance.toFixed(2)}</b>`,
      "",
      "Withdrawals are currently reviewed manually.",
      "Please contact @qevybtc and include your User ID, wallet address, coin/network, and requested amount.",
    ].join("\n"),
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
      "<b>ðŸ“ˆ Example Trade Alert</b>",
      "",
      "Kevy has opened a trade.",
      "",
      `<b>Coin:</b> ${coin}`,
      `<b>Entry:</b> ${DISPLAY_CURRENCY_SYMBOL}${entry}`,
      `<b>Current:</b> ${DISPLAY_CURRENCY_SYMBOL}${current}`,
      `<b>Profit:</b> +${profitPercent}%`,
      `<b>Estimated PnL:</b> +${DISPLAY_CURRENCY_SYMBOL}${estimatedPnl}`,
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
      "<b>âš ï¸ Risk Notice</b>",
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

bot.action(/^deposit_guide(?::(btc|eth|sol))?$/, async (ctx) => {
  await ctx.answerCbQuery();

  const coin = ctx.match && ctx.match[1] ? ctx.match[1] : "";

  await ctx.reply(getDepositGuideLines(coin).join("\n"), {
    parse_mode: "HTML",
    reply_markup: mainMenuReplyMarkup(),
  });
});

bot.action("new_to_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>ðŸ§‘â€ðŸ« New To Crypto?</b>",
      "",
      "<b>Wallet address:</b> This is where you send crypto. Copy it exactly.",
      "<b>Network:</b> This is the blockchain route. The coin and network must match.",
      "<b>Transaction hash:</b> This is your payment receipt. Kevy uses it to verify your deposit.",
      "",
      "If you are unsure, send a small test transaction first or contact @qevybtc before sending funds.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Deposit Guide", callback_data: "deposit_guide" }],
        [{ text: "How to buy crypto (easy)", callback_data: "how_to_buy_crypto_easy" }],
      ]),
    }
  );
});

bot.action("how_to_buy_crypto", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    [
      "<b>How To Buy CryptoðŸ“ˆ</b>",
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
      "Kevy Trading Bot is built to help you deposit funds, track your account, access trading tools like Snipe Bot and Bot Filters, check your payment status, verify deposits with transaction hashes, and get support whenever needed.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "New To Crypto?", callback_data: "new_to_crypto" }],
        [{ text: "Deposit Guide", callback_data: "deposit_guide" }],
      ]),
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
      "Transaction hash",
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

    await ctx.reply(formatDepositStatus(paymentId, payment), {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(getDepositButtons(payment)),
    });
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
      "<b>ðŸ“• How to setup KevyBot</b>",
      "",
      "1ï¸âƒ£ Press the â–ªï¸Deposit button to deposit funds into your account",
      "",
      "2ï¸âƒ£ Pick your preset of filters in âœ¨ Bot Filters",
      "",
      "3ï¸âƒ£ Let Kevy run in the backround while you enjoy your day",
      "",
      "4ï¸âƒ£ You will be alerted when Kevy makes a trade for you and explains how much profit you are in.",
      "",
      "5ï¸âƒ£ Withdraw using the â–«ï¸ Withdraw button and selecting which way you would like to recieve your funds.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup(),
    }
  );
});

bot.action(/^coin:(btc|eth|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply("This payment option is no longer available. Please use â–ªï¸ Deposit instead.", {
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
  verificationSessions.delete(String(ctx.from.id));

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

  const [paymentId] = cancelledDeposit;

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
        [{ text: "Create New Deposit", callback_data: "new_deposit" }],
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

  await ctx.reply(formatDepositStatus(paymentId, payment), {
    parse_mode: "HTML",
    reply_markup: mainMenuReplyMarkup(getDepositButtons(payment)),
  });
});

bot.action("submit_tx_hash", async (ctx) => {
  await ctx.answerCbQuery();

  const pendingDeposit = getLatestPendingDepositEntry(ctx.from.id, ctx.chat.id);

  if (!pendingDeposit) {
    await ctx.reply("You do not have a pending deposit to verify.", {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Create New Deposit", callback_data: "new_deposit" }],
      ]),
    });
    return;
  }

  const [paymentId, payment] = pendingDeposit;

  verificationSessions.set(String(ctx.from.id), {
    paymentId,
  });
  depositSessions.delete(String(ctx.from.id));

  await ctx.reply(
    [
      "<b>Paste your transaction hash</b>",
      "",
      `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
      `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
      "",
      "Kevy will check that the transaction was sent to the correct wallet address.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    }
  );
});

bot.on("text", async (ctx, next) => {
  const session = depositSessions.get(String(ctx.from.id));
  const verificationSession = verificationSessions.get(String(ctx.from.id));

  if (!session && !verificationSession) {
    return next();
  }

  if (verificationSession) {
    const txHash = ctx.message.text.trim();
    const payments = loadPayments();
    const payment = payments[verificationSession.paymentId];

    if (!payment) {
      verificationSessions.delete(String(ctx.from.id));
      await ctx.reply("I could not find that pending deposit anymore. Please create a new one.", {
        reply_markup: mainMenuReplyMarkup([
          [{ text: "Create New Deposit", callback_data: "new_deposit" }],
        ]),
      });
      return;
    }

    if (!isActiveUnpaidStatus(payment.status)) {
      verificationSessions.delete(String(ctx.from.id));
      await ctx.reply("This deposit is no longer pending.", {
        reply_markup: mainMenuReplyMarkup(),
      });
      return;
    }

    if (transactionHashAlreadyUsed(txHash, verificationSession.paymentId)) {
      await ctx.reply("This transaction hash has already been used for another deposit.", {
        reply_markup: mainMenuReplyMarkup([
          [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
        ]),
      });
      return;
    }

    await ctx.reply("Checking the blockchain now...");

    try {
      const result = await verifyBlockchainTransaction(payment.coin, txHash, payment.payAddress);

      if (!result.ok) {
        await ctx.reply(
          [
            "<b>Deposit not verified yet</b>",
            "",
            escapeHtml(result.detail),
            "",
            "Please check the transaction hash, make sure it is confirmed, then try again.",
          ].join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: mainMenuReplyMarkup([
              [{ text: "I Have Paid", callback_data: "submit_tx_hash" }],
              [{ text: "Support", callback_data: "support" }],
            ]),
          }
        );
        return;
      }

      payment.status = "finished";
      payment.updatedAt = new Date().toISOString();
      payment.txHash = txHash;
      payment.actuallyPaid = `${result.amount} ${result.currency}`;
      payment.blockchainVerifiedAt = new Date().toISOString();
      payment.blockchainVerificationDetail = result.detail;
      payment.adminCompletionAlertSentAt = new Date().toISOString();

      savePayments(payments);
      verificationSessions.delete(String(ctx.from.id));

      await sendAdminMessage(
        [
          "<b>âœ… Blockchain deposit verified</b>",
          "",
          `Payment ID: <code>${escapeHtml(verificationSession.paymentId)}</code>`,
          `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
          `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
          `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
          `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
          `Requested amount: ${escapeHtml(payment.payAmount || "unknown")}`,
          `Actually paid: ${escapeHtml(payment.actuallyPaid || "unknown")}`,
          `TX Hash: <code>${escapeHtml(txHash)}</code>`,
          `${EXPLORER_LINKS[payment.coin] || ""}${escapeHtml(txHash)}`,
          `Verified: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
        ].join("\n")
      );

      await ctx.reply(
        [
          "<b>âœ… Deposit verified</b>",
          "",
          "Your deposit has been confirmed. Your account has been updated.",
          "",
          `Actually paid: ${escapeHtml(payment.actuallyPaid)}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: mainMenuReplyMarkup(),
        }
      );
    } catch (error) {
      console.error("Blockchain verification error:", error.response?.data || error.message);

      await ctx.reply(
        [
          "<b>Verification error</b>",
          "",
          "Kevy could not check the blockchain right now. Please try again in a few minutes or contact @qevybtc.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: mainMenuReplyMarkup([
            [{ text: "I Have Paid", callback_data: "submit_tx_hash" }],
            [{ text: "Support", callback_data: "support" }],
          ]),
        }
      );
    }

    return;
  }

  const amountText = ctx.message.text.replace(/[Â£$,]/g, "").trim();
  const amount = Number.parseFloat(amountText);

  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply(`Please enter a valid deposit amount. Example: ${DISPLAY_CURRENCY_SYMBOL}50`, {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    });
    return;
  }

  if (amount < 20) {
    await ctx.reply(`Minimum deposit amount is 20 GBP. Please enter a higher amount.`, {
      reply_markup: mainMenuReplyMarkup([
        [{ text: "Cancel Deposit", callback_data: "cancel_deposit" }],
      ]),
    });
    return;
  }

  const cooldownSeconds = getPaymentCooldownSeconds(ctx.from.id);

  if (cooldownSeconds > 0) {
    await ctx.reply(`Please wait ${cooldownSeconds} seconds before creating another deposit.`, {
      reply_markup: mainMenuReplyMarkup(),
    });
    return;
  }

  startPaymentCooldown(ctx.from.id);
  depositSessions.delete(String(ctx.from.id));

  const coin = session.coin;
  const chatId = ctx.chat.id;
  const orderId = `deposit_${chatId}_${Date.now()}`;
  const telegramUsername = ctx.from.username ? `@${ctx.from.username}` : "";
  const telegramName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");

  await ctx.reply(`Creating your ${COINS[coin]} deposit...`);

  try {
    const paymentId = `manual_${coin}_${chatId}_${Date.now()}`;
    const payAddress = DEPOSIT_ADDRESSES[coin];
    const expiresAt = new Date(Date.now() + DEPOSIT_EXPIRY_MS).toISOString();

    const payments = loadPayments();

    payments[paymentId] = {
      paymentId,
      chatId,
      telegramUserId: ctx.from.id,
      telegramUsername,
      telegramName,
      orderId,
      coin,
      coinName: COINS[coin],
      status: "waiting",
      payAddress,
      payAmount: `${DISPLAY_CURRENCY_SYMBOL}${amount} GBP worth of ${coin.toUpperCase()}`,
      priceAmount: amount,
      priceCurrency: DISPLAY_CURRENCY_CODE.toLowerCase(),
      createdAt: new Date().toISOString(),
      updatedAt: "",
      actuallyPaid: "",
      outcomeAmount: "",
      outcomeCurrency: "",
      reminderSentAt: "",
      ipnHistory: [],
      type: "deposit",
      depositExpiresAt: expiresAt,
    };

    savePayments(payments);

    await sendAdminMessage(
      [
        "<b>New manual deposit attempt</b>",
        `Payment ID: <code>${escapeHtml(paymentId)}</code>`,
        `User ID: <code>${escapeHtml(ctx.from.id)}</code>`,
        `Username: ${escapeHtml(telegramUsername || "none")}`,
        `Name: ${escapeHtml(telegramName || "unknown")}`,
        `Coin: ${escapeHtml(coin.toUpperCase())}`,
        `Amount: ${escapeHtml(`${DISPLAY_CURRENCY_SYMBOL}${amount} GBP`)}`,
        `Address: <code>${escapeHtml(payAddress)}</code>`,
        `Created: ${escapeHtml(formatTimestamp(new Date().toISOString()))}`,
      ].join("\n")
    );

    await ctx.reply(
      [
        "<b>Deposit Instructions</b>",
        "",
        "Your deposit will expire in 60 minutes.",
        NETWORK_WARNINGS[coin],
        `Deposits under ${DISPLAY_CURRENCY_SYMBOL}20 will not be credited.`,
        "",
        `<b>Send ${COINS[coin]} deposit to this address:</b>`,
        "",
        `<code>${escapeHtml(payAddress)}</code>`,
        "",
        `<b>Amount:</b> <code>${DISPLAY_CURRENCY_SYMBOL}${amount} GBP</code>`,
        "",
        `<b>Payment ID:</b> <code>${escapeHtml(paymentId)}</code>`,
        "<b>Keep this Payment ID safe. You may need it for support.</b>",
        `<b>Expires:</b> ${escapeHtml(formatTimestamp(expiresAt))}`,
        `<b>Expires in:</b> ${escapeHtml(formatTimeRemaining(expiresAt))}`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: mainMenuReplyMarkup([
          [
            {
              text: "Copy address",
              copy_text: {
                text: payAddress,
              },
            },
          ],
          [
            {
              text: "Copy Amount",
              copy_text: {
                text: String(amount),
              },
            },
          ],
          [{ text: "I Have Paid", callback_data: "submit_tx_hash" }],
          [{ text: "Check Deposit Status", callback_data: "check_deposit_status" }],
          [{ text: "Create New Deposit", callback_data: "new_deposit" }],
          [{ text: "Cancel Pending Deposit", callback_data: "cancel_deposit" }],
          [{ text: "Deposit Guide", callback_data: `deposit_guide:${coin}` }],
          [{ text: "How to buy crypto (easy)", callback_data: "how_to_buy_crypto_easy" }],
        ]),
      }
    );
  } catch (error) {
    console.error(error.message);
    await ctx.reply("Sorry, I could not create the deposit. Please try again.", {
      reply_markup: mainMenuReplyMarkup(),
    });
  }
});

app.post("/nowpayments-ipn", async (req, res) => {
  console.log("NOWPayments IPN received:");
  console.log(JSON.stringify(req.body, null, 2));

  const signature = req.headers["x-nowpayments-sig"];

  if (!verifyNowPaymentsSignature(req.body, signature)) {
    console.error("Invalid NOWPayments IPN signature");
    return res.status(401).send("Invalid signature");
  }

  const { payment_id, payment_status } = req.body;
  const payments = loadPayments();
  const payment = payments[payment_id];

  if (!payment) {
    console.error(`Unknown payment ID from NOWPayments: ${payment_id}`);
    return res.status(200).send("Unknown payment");
  }

  const previousStatus = payment.status || "unknown";
  const newStatus = String(payment_status || previousStatus).toLowerCase();

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

  if (
    ["finished", "partially_paid"].includes(newStatus) &&
    !payment.adminCompletionAlertSentAt
  ) {
    await sendAdminMessage(
      [
        newStatus === "finished"
          ? "<b>âœ… Payment completed</b>"
          : "<b>âš ï¸ Payment partially paid</b>",
        "",
        `Payment ID: <code>${escapeHtml(payment_id)}</code>`,
        `User ID: <code>${escapeHtml(payment.telegramUserId || payment.chatId || "unknown")}</code>`,
        `Username: ${escapeHtml(payment.telegramUsername || "none")}`,
        `Name: ${escapeHtml(payment.telegramName || "unknown")}`,
        `Coin: ${escapeHtml((payment.coin || "unknown").toUpperCase())}`,
        `Amount: ${escapeHtml(payment.payAmount || "unknown")}`,
        `Actually paid: ${escapeHtml(payment.actuallyPaid || "unknown")}`,
        `Status: <b>${escapeHtml(newStatus)}</b>`,
        `Completed: ${escapeHtml(formatTimestamp(payment.updatedAt))}`,
      ].join("\n")
    );

    payment.adminCompletionAlertSentAt = new Date().toISOString();
    savePayments(payments);
  }

  if (newStatus === "finished" && previousStatus !== "finished") {
    try {
      await bot.telegram.sendMessage(
        payment.chatId,
        "Your deposit has been confirmed. Your account has been updated.",
        {
          reply_markup: mainMenuReplyMarkup(),
        }
      );
    } catch (error) {
      console.error("Could not send user payment completion message:", error.message);
    }
  }

  if (newStatus !== "finished" && newStatus !== previousStatus) {
    const userMessage = getUserStatusMessage(newStatus);

    if (userMessage) {
      const extraButtons =
        newStatus === "expired"
          ? [[{ text: "Create New Deposit", callback_data: "new_deposit" }]]
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

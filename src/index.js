const express = require("express");
const { Server } = require("socket.io");
const { Bot, InlineKeyboard } = require("grammy");
const { pool, testDbConnection, migrateDatabase } = require("./db");
const { requireTelegramUser, verifyTelegramInitData } = require("./auth");
const { gameTick, buyTicket, getGameState } = require("./game");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || "");
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://victor-bingo.onrender.com";

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

app.get("/health", (req,res) => res.json({ok:true,service:"victor-bingo"}));
app.get("/api/config", (req,res) => res.json({
  ticketPriceCents:1000,
  paymentName:process.env.PAYMENT_ACCOUNT_NAME || "Samuel Adino",
  telebirrNumber:process.env.TELEBIRR_NUMBER || "0945723383",
  cbeNumber:process.env.CBE_BIRR_NUMBER || "0945723383",
  botUrl:process.env.BOT_USERNAME ? "https://t.me/" + process.env.BOT_USERNAME.replace(/^@/,"") : null
}));

app.get("/api/state", requireTelegramUser, async (req,res) => {
  try { res.json(await getGameState(req.victorUser)); }
  catch(error) { console.error(error); res.status(500).json({error:"Could not load game state."}); }
});

app.post("/api/tickets", requireTelegramUser, async (req,res) => {
  try {
    const result = await buyTicket(req.victorUser.telegram_id, req.body?.cardNumber ?? null);
    res.json({ok:true,ticket:{id:result.ticket.id,cardNumber:result.ticket.card_number,card:result.ticket.card},balanceCents:result.balanceCents});
  } catch(error) {
    const messages = {
      USER_NOT_FOUND:"Player account not found.",
      ROUND_CLOSED:"This round is closed. Wait for the next round.",
      INSUFFICIENT_BALANCE:"Your Wallet balance is not enough. Please deposit first.",
      ROOM_FULL:"All Cartela numbers are sold for this round.",
      MAX_TICKETS:"You can buy a maximum of 2 Cartelas per round.",
      INVALID_CARD:"Choose a valid Cartela number from 1 to 600.",
      CARD_SOLD:"This Cartela has already been sold. Choose another one."
    };
    res.status(400).json({error:messages[error.message] || "Could not buy Cartela."});
  }
});

app.get("/api/wallet/history", requireTelegramUser, async (req,res) => {
  try {
    const result = await pool.query(
      "SELECT type,amount_cents,note,created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 30",
      [req.victorUser.id]
    );
    res.json({transactions:result.rows});
  } catch(error) { res.status(500).json({error:"Could not load wallet history."}); }
});

app.post("/api/payments", requireTelegramUser, async (req,res) => {
  const {kind,method,amount,payoutAccount,senderReference} = req.body || {};
  const cents = Math.round(Number(amount) * 100);
  if (!["deposit","withdrawal"].includes(kind) || !["telebirr","cbe"].includes(method) ||
      !Number.isSafeInteger(cents) || cents < 100 || cents > 100000000) {
    return res.status(400).json({error:"Enter a valid amount (minimum 1 ETB) and payment method."});
  }
  if (kind === "withdrawal" && (!payoutAccount || String(payoutAccount).trim().length < 5)) {
    return res.status(400).json({error:"Enter the account or phone number for the withdrawal."});
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (kind === "withdrawal") {
      const wallet = await client.query("SELECT wallet_cents FROM users WHERE id=$1 FOR UPDATE",[req.victorUser.id]);
      if (!wallet.rows[0] || Number(wallet.rows[0].wallet_cents) < cents) throw new Error("INSUFFICIENT_BALANCE");
      await client.query("UPDATE users SET wallet_cents=wallet_cents-$1 WHERE id=$2",[cents,req.victorUser.id]);
    }
    const result = await client.query(
      "INSERT INTO payment_requests(user_id,kind,method,amount_cents,payout_account,sender_reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status",
      [req.victorUser.id,kind,method,cents,kind==="withdrawal"?String(payoutAccount).trim():null,senderReference?String(senderReference).trim().slice(0,120):null]
    );
    if (kind === "withdrawal") {
      await client.query(
        "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'withdrawal_hold',$2,$3,$4)",
        [req.victorUser.id,-cents,`withdrawal-request-${result.rows[0].id}`,"Withdrawal request pending review"]
      );
    }
    await client.query("COMMIT");
    res.json({ok:true,requestId:result.rows[0].id,status:"pending"});
  } catch(error) {
    await client.query("ROLLBACK");
    res.status(400).json({error:error.message==="INSUFFICIENT_BALANCE"?"Insufficient Wallet balance.":"Could not create payment request."});
  } finally { client.release(); }
});

async function reviewPayment(requestId, action, adminId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[requestId]);
    const request = found.rows[0];
    if (!request || request.status !== "pending") throw new Error("Request not found or already reviewed.");
    if (action === "approve" && request.kind === "deposit") {
      await client.query("UPDATE users SET wallet_cents=wallet_cents+$1 WHERE id=$2",[request.amount_cents,request.user_id]);
      await client.query(
        "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'deposit',$2,$3,$4)",
        [request.user_id,request.amount_cents,`deposit-request-${request.id}`,`Approved ${request.method} deposit`]
      );
    }
    if (action === "reject" && request.kind === "withdrawal") {
      await client.query("UPDATE users SET wallet_cents=wallet_cents+$1 WHERE id=$2",[request.amount_cents,request.user_id]);
      await client.query(
        "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'withdrawal_refund',$2,$3,$4)",
        [request.user_id,request.amount_cents,`withdrawal-refund-${request.id}`,"Rejected withdrawal returned to Wallet"]
      );
    }
    await client.query(
      "UPDATE payment_requests SET status=$2,admin_telegram_id=$3,reviewed_at=NOW() WHERE id=$1",
      [request.id,action==="approve"?"approved":"rejected",String(adminId)]
    );
    await client.query("COMMIT");
    return request;
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);
  const walletSteps = new Map();
  const walletMenu = () => new InlineKeyboard()
    .text("💳 Deposit", "wallet:deposit").text("💸 Withdrawal", "wallet:withdrawal").row()
    .text("📜 Wallet History", "wallet:history").text("💰 Balance", "wallet:balance");
  const paymentMethodMenu = () => new InlineKeyboard()
    .text("Telebirr", "method:telebirr").text("CBE Birr", "method:cbe");
  bot.command("wallet", async ctx => {
    const user = await pool.query("SELECT wallet_cents FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
    const balance = user.rows[0] ? (Number(user.rows[0].wallet_cents)/100).toFixed(2) : "0.00";
    await ctx.reply("💰 Victor Bingo Wallet\nBalance: " + balance + " ETB\n\nChoose an action:",{reply_markup:walletMenu()});
  });
  bot.command("balance", async ctx => {
    const user = await pool.query("SELECT wallet_cents FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
    const balance = user.rows[0] ? (Number(user.rows[0].wallet_cents)/100).toFixed(2) : "0.00";
    await ctx.reply("💰 Your Wallet balance: " + balance + " ETB");
  });
  bot.callbackQuery(/^wallet:(deposit|withdrawal|history|balance)$/, async ctx => {
    const action = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (action === "balance") {
      const u = await pool.query("SELECT wallet_cents FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
      return ctx.reply("💰 Your Wallet balance: " + (u.rows[0] ? (Number(u.rows[0].wallet_cents)/100).toFixed(2) : "0.00") + " ETB");
    }
    if (action === "history") {
      const u = await pool.query("SELECT id FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
      if (!u.rows[0]) return ctx.reply("No wallet transactions yet.");
      const h = await pool.query("SELECT type,amount_cents,note,created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 15",[u.rows[0].id]);
      if (!h.rows.length) return ctx.reply("📜 Wallet History\n\nNo transactions yet.");
      const lines = h.rows.map(x => {
        const sign = Number(x.amount_cents) >= 0 ? "+" : "";
        return sign + (Number(x.amount_cents)/100).toFixed(2) + " ETB · " + x.type + (x.note ? " · " + x.note : "");
      });
      return ctx.reply("📜 Wallet History\n\n" + lines.join("\n"));
    }
    walletSteps.set(String(ctx.from.id), {kind:action,step:"amount"});
    return ctx.reply(action === "deposit"
      ? "💳 Deposit request\n\nPayment account: Samuel Adino\nTelebirr: 0945723383\nCBE Birr: 0945723383\n\nEnter amount in ETB:"
      : "💸 Withdrawal request\n\nEnter amount in ETB:");
  });
  bot.callbackQuery(/^method:(telebirr|cbe)$/, async ctx => {
    const state = walletSteps.get(String(ctx.from.id));
    if (!state || state.step !== "method") return ctx.answerCallbackQuery({text:"Start a new Wallet request first."});
    state.method = ctx.match[1];
    state.step = state.kind === "withdrawal" ? "account" : "reference";
    await ctx.answerCallbackQuery();
    await ctx.reply(state.kind === "withdrawal"
      ? "Enter the Telebirr/CBE Birr phone or account number where you want to receive the money:"
      : "Send the payment transaction/reference number, upload a payment screenshot, or type SKIP:");
  });
  bot.on("message:photo", async (ctx,next) => {
    const state = walletSteps.get(String(ctx.from.id));
    if (!state || state.step !== "reference" || state.kind !== "deposit") return next();
    const photos = ctx.message.photo || [];
    const proofFileId = photos.length ? photos[photos.length - 1].file_id : null;
    if (!proofFileId) return ctx.reply("I could not read that image. Please send the screenshot again.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM users WHERE telegram_id=$1 FOR UPDATE",[String(ctx.from.id)]);
      if (!user.rows[0]) throw new Error("Open the game with /start first so your player account is created.");
      const req = await client.query(
        "INSERT INTO payment_requests(user_id,kind,method,amount_cents,sender_reference,proof_file_id) VALUES($1,'deposit',$2,$3,$4,$5) RETURNING id",
        [user.rows[0].id,state.method,state.amount,ctx.message.caption ? String(ctx.message.caption).slice(0,120) : null,proofFileId]
      );
      await client.query("COMMIT");
      walletSteps.delete(String(ctx.from.id));
      const caption = "📥 NEW DEPOSIT REQUEST #" + req.rows[0].id +
        "\nPlayer Telegram ID: " + ctx.from.id +
        "\nMethod: " + state.method.toUpperCase() +
        "\nAmount: " + (state.amount/100).toFixed(2) + " ETB";
      if (ADMIN_ID) {
        try { await bot.api.sendPhoto(ADMIN_ID,proofFileId,{caption,reply_markup:new InlineKeyboard().text("✅ Approve","payment:approve:"+req.rows[0].id).text("❌ Reject","payment:reject:"+req.rows[0].id)}); }
        catch (sendError) { console.error("Could not forward deposit proof to admin:",sendError.message); }
      }
      return ctx.reply("✅ DEPOSIT request submitted.\nRequest ID: #" + req.rows[0].id +
        "\nAmount: " + (state.amount/100).toFixed(2) + " ETB\nStatus: Pending admin review.\n\nYour screenshot has been sent for verification. Your Wallet will be credited only after admin approval.");
    } catch(error) {
      await client.query("ROLLBACK");
      walletSteps.delete(String(ctx.from.id));
      return ctx.reply("❌ " + error.message);
    } finally { client.release(); }
  });
  bot.on("message:text", async (ctx,next) => {
    const state = walletSteps.get(String(ctx.from.id));
    if (!state) return next();
    const value = ctx.message.text.trim();
    if (value.startsWith("/")) return next();
    if (state.step === "amount") {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) return ctx.reply("Enter a valid amount of at least 1 ETB:");
      state.amount = Math.round(amount * 100);
      state.step = "method";
      return ctx.reply("Choose payment method:",{reply_markup:paymentMethodMenu()});
    }
    if (state.step === "account") {
      if (value.length < 5 || value.length > 80) return ctx.reply("Enter a valid receiving account or phone number:");
      state.payoutAccount = value;
      if (state.kind === "withdrawal") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const user = await client.query("SELECT id,wallet_cents FROM users WHERE telegram_id=$1 FOR UPDATE",[String(ctx.from.id)]);
          if (!user.rows[0]) throw new Error("Open the game with /start first so your player account is created.");
          if (Number(user.rows[0].wallet_cents) < state.amount) throw new Error("Insufficient Wallet balance.");
          await client.query("UPDATE users SET wallet_cents=wallet_cents-$1 WHERE id=$2",[state.amount,user.rows[0].id]);
          const req = await client.query(
            "INSERT INTO payment_requests(user_id,kind,method,amount_cents,payout_account,sender_reference) VALUES($1,'withdrawal',$2,$3,$4,NULL) RETURNING id",
            [user.rows[0].id,state.method,state.amount,state.payoutAccount]
          );
          await client.query(
            "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'withdrawal_hold',$2,$3,$4)",
            [user.rows[0].id,-state.amount,"withdrawal-request-"+req.rows[0].id,"Withdrawal request pending review"]
          );
          await client.query("COMMIT");
          walletSteps.delete(String(ctx.from.id));
          const requestId = req.rows[0].id;
          if (ADMIN_ID) {
            const adminText = "💸 NEW WITHDRAWAL REQUEST #" + requestId +
              "\\nPlayer Telegram ID: " + ctx.from.id +
              "\\nMethod: " + state.method.toUpperCase() +
              "\\nAmount: " + (state.amount/100).toFixed(2) + " ETB" +
              "\\nReceiving account: " + state.payoutAccount;
            try {
              await bot.api.sendMessage(ADMIN_ID,adminText,{
                reply_markup:new InlineKeyboard().text("✅ Approve","payment:approve:"+requestId).text("❌ Reject","payment:reject:"+requestId)
              });
            } catch(sendError) { console.error("Could not notify admin about withdrawal:",sendError.message); }
          }
          return ctx.reply("✅ WITHDRAWAL request submitted.\\nRequest ID: #" + requestId + "\\nAmount: " + (state.amount/100).toFixed(2) + " ETB\\nPayout method: " + state.method.toUpperCase() + "\\nReceiving account: " + state.payoutAccount + "\\nStatus: Pending admin review.\\n\\nThe amount is held until your withdrawal is reviewed.");
        } catch(error) {
          await client.query("ROLLBACK");
          walletSteps.delete(String(ctx.from.id));
          return ctx.reply("❌ " + error.message);
        } finally { client.release(); }
      }
      state.step = "reference";
      return ctx.reply("Send the payment transaction/reference number, upload a payment screenshot, or type SKIP:");
    }
    if (state.step === "reference") {
      state.reference = value.toUpperCase() === "SKIP" ? null : value.slice(0,120);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = await client.query("SELECT id,wallet_cents FROM users WHERE telegram_id=$1 FOR UPDATE",[String(ctx.from.id)]);
        if (!user.rows[0]) throw new Error("Open the game with /start first so your player account is created.");
        if (state.kind === "withdrawal" && Number(user.rows[0].wallet_cents) < state.amount) throw new Error("Insufficient Wallet balance.");
        if (state.kind === "withdrawal") await client.query("UPDATE users SET wallet_cents=wallet_cents-$1 WHERE id=$2",[state.amount,user.rows[0].id]);
        const req = await client.query(
          "INSERT INTO payment_requests(user_id,kind,method,amount_cents,payout_account,sender_reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [user.rows[0].id,state.kind,state.method,state.amount,state.payoutAccount || null,state.reference]
        );
        if (state.kind === "withdrawal") await client.query(
          "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'withdrawal_hold',$2,$3,$4)",
          [user.rows[0].id,-state.amount,"withdrawal-request-"+req.rows[0].id,"Withdrawal request pending review"]
        );
        await client.query("COMMIT");
        walletSteps.delete(String(ctx.from.id));
        return ctx.reply("✅ " + state.kind.toUpperCase() + " request submitted.\nRequest ID: #" + req.rows[0].id + "\nAmount: " + (state.amount/100).toFixed(2) + " ETB\nStatus: Pending admin review.\n\n" + (state.kind === "deposit" ? "Your Wallet will be credited only after payment is verified." : "The amount is held until your withdrawal is reviewed."));
      } catch(error) {
        await client.query("ROLLBACK");
        walletSteps.delete(String(ctx.from.id));
        return ctx.reply("❌ " + error.message);
      } finally { client.release(); }
    }
  });
  bot.command("start", async ctx => {
    await pool.query(
      "INSERT INTO users(telegram_id,first_name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username",
      [String(ctx.from.id),ctx.from.first_name || "Player",ctx.from.username || null]
    );
    const keyboard = new InlineKeyboard().webApp("🎮 Play Victor Bingo", BASE_URL + "/").row()
      .text("💰 My balance", "wallet:balance").row()
      .webApp("💳 Deposit", BASE_URL + "/?screen=deposit").row()
      .text("💸 Withdrawal", "wallet:withdrawal").row()
      .text("📜 Transaction history", "wallet:history").row()
      .text("📖 Instruction", "instruction").row()
      .text("📝 Register", "register");
    await ctx.reply("🎉 Welcome to Victor Bingo!\n\nCartela: 10 ETB\nSelect an option from the menu below:",{reply_markup:keyboard});
  });
  bot.callbackQuery("instruction", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply("📖 Victor Bingo Instructions\n\n1. Press Play Victor Bingo to open the game.\n2. Register with your Telegram account.\n3. Deposit using Telebirr or CBE Birr; admin verifies deposits.\n4. Each Cartela costs 10 ETB.\n5. Choose/buy Cartela before the 30-second countdown ends.\n6. Bingo numbers 1–75 are drawn automatically.\n7. Complete a row, column, diagonal, or four corners to win.\n8. 80% of ticket sales goes to winner(s); 20% is the house share.\n9. Withdrawals are reviewed by the admin.");
  });
  bot.callbackQuery("register", async ctx => {
    await pool.query(
      "INSERT INTO users(telegram_id,first_name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username",
      [String(ctx.from.id),ctx.from.first_name || "Player",ctx.from.username || null]
    );
    await ctx.answerCallbackQuery({text:"Registration successful!"});
    await ctx.reply("✅ You are registered in Victor Bingo!\nYour Telegram account is linked to your Wallet.");
  });
  bot.command("admin", async ctx => {
    if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) return ctx.reply("⛔ Admin access denied.");
    await ctx.reply("Victor Bingo Admin\n/pending - View payment requests\n/approve_deposit ID\n/reject_deposit ID\n/approve_withdrawal ID\n/reject_withdrawal ID");
  });
  bot.command("pending", async ctx => {
    if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) return ctx.reply("⛔ Admin access denied.");
    const result = await pool.query("SELECT id,kind,method,amount_cents,payout_account,sender_reference,proof_file_id FROM payment_requests WHERE status='pending' ORDER BY id LIMIT 30");
    if (!result.rows.length) return ctx.reply("No pending payment requests.");
    const lines = result.rows.map(r => `#${r.id} ${r.kind.toUpperCase()} ${r.method} ${(Number(r.amount_cents)/100).toFixed(2)} ETB${r.payout_account?" → "+r.payout_account:""}${r.sender_reference?" Ref: "+r.sender_reference:""}${r.proof_file_id?" 📷 Screenshot attached":""}`);
    await ctx.reply(lines.join("\n"));
  });
  for (const [command,action,kind] of [
    ["approve_deposit","approve","deposit"],["reject_deposit","reject","deposit"],
    ["approve_withdrawal","approve","withdrawal"],["reject_withdrawal","reject","withdrawal"]
  ]) {
    bot.command(command, async ctx => {
      if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) return ctx.reply("⛔ Admin access denied.");
      const id = Number(ctx.match);
      if (!Number.isSafeInteger(id) || id<1) return ctx.reply(`Usage: /${command} REQUEST_ID`);
      try {
        const request = await pool.query("SELECT kind FROM payment_requests WHERE id=$1",[id]);
        if (!request.rows[0] || request.rows[0].kind!==kind) return ctx.reply("Request not found.");
        const reviewed = await reviewPayment(id,action,ctx.from.id);
        await ctx.reply(`Request #${id} ${action === "approve" ? "approved" : "rejected"} successfully.`);
      } catch(error) { await ctx.reply(error.message); }
    });
  }
  bot.callbackQuery(/^payment:(approve|reject):(\d+)$/, async ctx => {
    if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) {
      await ctx.answerCallbackQuery({text:"Admin access denied.",show_alert:true});
      return;
    }
    const match = ctx.callbackQuery.data.match(/^payment:(approve|reject):(\d+)$/);
    const action = match[1];
    const id = Number(match[2]);
    try {
      const request = await pool.query("SELECT kind,status FROM payment_requests WHERE id=$1",[id]);
      if (!request.rows[0] || !["deposit","withdrawal"].includes(request.rows[0].kind)) {
        await ctx.answerCallbackQuery({text:"Payment request not found.",show_alert:true});
        return;
      }
      if (request.rows[0].status !== "pending") {
        await ctx.answerCallbackQuery({text:"This request has already been reviewed.",show_alert:true});
        return;
      }
      await reviewPayment(id,action,ctx.from.id);
      const kindLabel = request.rows[0].kind === "withdrawal" ? "Withdrawal" : "Deposit";
      await ctx.answerCallbackQuery({text:kindLabel + (action === "approve" ? " approved." : " rejected.")});
      const statusText = "\\n\\n" + (action === "approve" ? "✅ APPROVED by admin" : "❌ REJECTED by admin");
      if (ctx.callbackQuery.message.caption) {
        await ctx.editMessageCaption({caption:ctx.callbackQuery.message.caption + statusText,reply_markup:{inline_keyboard:[]}});
      } else {
        await ctx.editMessageText(ctx.callbackQuery.message.text + statusText,{reply_markup:{inline_keyboard:[]}});
      }
      await ctx.reply(kindLabel + " request #" + id + " " + (action === "approve" ? "approved" : "rejected") + " successfully." + (request.rows[0].kind === "withdrawal" && action === "approve" ? " Remember to send the payout to the player's receiving account." : ""));
    } catch(error) {
      await ctx.answerCallbackQuery({text:error.message.slice(0,180),show_alert:true});
    }
  });
  bot.catch(err => console.error("Telegram bot error:",err));
  bot.start().catch(err => console.error("Telegram polling failed:",err));
} else {
  console.log("BOT_TOKEN is not set yet; Telegram bot is disabled.");
}

app.get("/", (req,res) => res.sendFile(require("path").join(__dirname,"..","public","index.html")));

const server = app.listen(PORT,"0.0.0.0",async () => {
  console.log(`Victor Bingo server running on port ${PORT}`);
  const connected = await testDbConnection();
  if (connected) {
    try {
      await migrateDatabase();
      await gameTick();
      setInterval(async () => {
        await gameTick();
        for (const socket of io.sockets.sockets.values()) {
          try {
            const state = await getGameState(socket.data.victorUser);
            socket.emit("game:state", state);
          } catch (error) {
            console.error("Socket state broadcast failed:", error.message);
          }
        }
      },1000);
    } catch(error) {
      console.error("Victor Bingo startup migration failed:",error.message);
    }
  }
});


// Authenticated real-time updates. Each player receives only their own Cartelas.
const io = new Server(server, {
  cors: { origin: true, methods: ["GET"] }
});

io.use(async (socket, next) => {
  try {
    const tg = verifyTelegramInitData(socket.handshake.auth?.initData || "");
    if (!tg?.id) return next(new Error("Telegram authentication required"));
    const result = await pool.query(
      "INSERT INTO users(telegram_id,first_name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username RETURNING id,telegram_id,first_name,username",
      [String(tg.id), String(tg.first_name || "Player").slice(0,100), tg.username ? String(tg.username).slice(0,100) : null]
    );
    socket.data.victorUser = result.rows[0];
    next();
  } catch (error) {
    console.error("Socket authentication failed:", error.message);
    next(new Error("Could not authenticate Telegram user"));
  }
});

io.on("connection", async socket => {
  try {
    socket.emit("game:state", await getGameState(socket.data.victorUser));
  } catch (error) {
    console.error("Initial socket state failed:", error.message);
  }
});

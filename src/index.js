const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { pool, testDbConnection, migrateDatabase } = require("./db");
const { requireTelegramUser } = require("./auth");
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
  cbeNumber:process.env.CBE_BIRR_NUMBER || "0945723383"
}));

app.get("/api/state", requireTelegramUser, async (req,res) => {
  try { res.json(await getGameState(req.victorUser)); }
  catch(error) { console.error(error); res.status(500).json({error:"Could not load game state."}); }
});

app.post("/api/tickets", requireTelegramUser, async (req,res) => {
  try {
    const result = await buyTicket(req.victorUser.telegram_id);
    res.json({ok:true,ticket:{id:result.ticket.id,cardNumber:result.ticket.card_number,card:result.ticket.card},balanceCents:result.balanceCents});
  } catch(error) {
    const messages = {
      USER_NOT_FOUND:"Player account not found.",
      ROUND_CLOSED:"This round is closed. Wait for the next round.",
      INSUFFICIENT_BALANCE:"Your Wallet balance is not enough. Please deposit first.",
      ROOM_FULL:"All Cartela numbers are sold for this round."
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
  bot.command("start", async ctx => {
    const keyboard = new InlineKeyboard().webApp("🎮 PLAY VICTOR BINGO", BASE_URL + "/");
    await ctx.reply("🎉 Welcome to Victor Bingo!\n\nCartela: 10 ETB\nChoose Play to enter the game.",{reply_markup:keyboard});
  });
  bot.command("admin", async ctx => {
    if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) return ctx.reply("⛔ Admin access denied.");
    await ctx.reply("Victor Bingo Admin\n/pending - View payment requests\n/approve_deposit ID\n/reject_deposit ID\n/approve_withdrawal ID\n/reject_withdrawal ID");
  });
  bot.command("pending", async ctx => {
    if (!ADMIN_ID || String(ctx.from.id)!==ADMIN_ID) return ctx.reply("⛔ Admin access denied.");
    const result = await pool.query("SELECT id,kind,method,amount_cents,payout_account,sender_reference FROM payment_requests WHERE status='pending' ORDER BY id LIMIT 30");
    if (!result.rows.length) return ctx.reply("No pending payment requests.");
    const lines = result.rows.map(r => `#${r.id} ${r.kind.toUpperCase()} ${r.method} ${(Number(r.amount_cents)/100).toFixed(2)} ETB${r.payout_account?" → "+r.payout_account:""}${r.sender_reference?" Ref: "+r.sender_reference:""}`);
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
        await ctx.reply(`Request #${id} ${action}d successfully.`);
      } catch(error) { await ctx.reply(error.message); }
    });
  }
  bot.catch(err => console.error("Telegram bot error:",err));
  bot.start().catch(err => console.error("Telegram polling failed:",err));
} else {
  console.log("BOT_TOKEN is not set yet; Telegram bot is disabled.");
}

app.get("/", (req,res) => res.sendFile(require("path").join(__dirname,"..","public","index.html")));

app.listen(PORT,"0.0.0.0",async () => {
  console.log(`Victor Bingo server running on port ${PORT}`);
  const connected = await testDbConnection();
  if (connected) {
    try {
      await migrateDatabase();
      await gameTick();
      setInterval(gameTick,1000);
    } catch(error) {
      console.error("Victor Bingo startup migration failed:",error.message);
    }
  }
});

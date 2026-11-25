const crypto = require("crypto");
const { pool } = require("./db");

function verifyTelegramInitData(initData) {
  const token = process.env.BOT_TOKEN;
  if (!token || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256","WebAppData").update(token).digest();
  const expected = crypto.createHmac("sha256",secret).update(dataCheckString).digest("hex");
  const actualBuffer = Buffer.from(hash,"hex");
  const expectedBuffer = Buffer.from(expected,"hex");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer,expectedBuffer)) return null;
  const authDate = Number(params.get("auth_date")||0);
  if (!authDate || Date.now()/1000-authDate > 86400 || authDate > Date.now()/1000+60) return null;
  try { return JSON.parse(params.get("user")||"null"); } catch { return null; }
}

async function requireTelegramUser(req,res,next) {
  try {
    const tg = verifyTelegramInitData(req.get("X-Telegram-Init-Data")||"");
    if (!tg?.id) return res.status(401).json({error:"Open the Mini App from the Victor Bingo Telegram bot."});
    const result = await pool.query(
      "INSERT INTO users(telegram_id,first_name,username) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username RETURNING id,telegram_id,first_name,username",
      [String(tg.id),String(tg.first_name||"Player").slice(0,100),tg.username?String(tg.username).slice(0,100):null]
    );
    req.victorUser = result.rows[0];
    next();
  } catch(error) {
    console.error("Telegram auth failed:",error.message);
    res.status(500).json({error:"Authentication service error."});
  }
}
module.exports = {requireTelegramUser,verifyTelegramInitData};

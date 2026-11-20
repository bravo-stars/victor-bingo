const express = require("express");
const { Bot } = require("grammy");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

app.use(express.json());
app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "victor-bingo" });
});

app.get("/", (req, res) => {
  res.send("Victor Bingo server is running!");
});

if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);

  bot.command("start", async (ctx) => {
    await ctx.reply("🎉 Welcome to Victor Bingo!");
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  bot.start().catch(console.error);
} else {
  console.log("BOT_TOKEN is not set yet.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Victor Bingo server running on port ${PORT}`);
});

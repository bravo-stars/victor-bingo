# Victor Bingo

Server-authoritative Telegram Bingo Mini App using Node.js, Express, grammY, and Neon PostgreSQL.

## Game rules
- Cartela price: 10 ETB.
- 30-second server-controlled purchase countdown.
- Random 5x5 B-I-N-G-O cards with a FREE center.
- Numbers 1–75 are drawn without repeats.
- A winner completes any row, column, diagonal, or all four corners.
- 80% of the round's Cartela sales is divided equally among all winners; 20% is retained by the house.
- Winner results are shown for 10 seconds before the next round starts.
- Ball draw interval defaults to 6 seconds and can be changed with `BALL_INTERVAL_MS`.

## Render environment variables
Set these in the Render Web Service Environment. Never commit secrets to GitHub.

Required:
- `DATABASE_URL`: Neon PostgreSQL connection string.
- `BOT_TOKEN`: Telegram bot token from BotFather.
- `ADMIN_TELEGRAM_ID`: Telegram numeric ID allowed to use admin commands.

Optional:
- `BOT_USERNAME`: Telegram bot username without or with @; used to show the bot link on the web page.
- `PAYMENT_ACCOUNT_NAME`: deposit account holder (default: Samuel Adino).
- `TELEBIRR_NUMBER`: Telebirr payment number (default: 0945723383).
- `CBE_BIRR_NUMBER`: CBE Birr payment number (default: 0945723383).
- `BALL_INTERVAL_MS`: ball interval in milliseconds (default: 6000).

The app creates/updates its database tables at startup from `src/schema.sql`.

## Telegram bot
Send `/start` to open the Mini App. The app verifies Telegram Web App initData server-side; opening the game URL directly in a normal browser does not authenticate a player.

Admin commands (only `ADMIN_TELEGRAM_ID`):
- `/admin` — show admin commands.
- `/pending` — list pending deposit and withdrawal requests.
- `/approve_deposit REQUEST_ID` — credit a deposit after checking the payment arrived.
- `/reject_deposit REQUEST_ID` — reject a deposit.
- `/approve_withdrawal REQUEST_ID` — mark a withdrawal paid after sending the money manually.
- `/reject_withdrawal REQUEST_ID` — reject a withdrawal and return the held amount to the player's wallet.

Deposit requests are never credited automatically. Withdrawal requests hold the amount until approval or rejection; the administrator must send the actual payment manually before approving.

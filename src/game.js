const { pool } = require("./db");

const TICKET_PRICE_CENTS = 1000;
const COUNTDOWN_SECONDS = 30;
const BALL_INTERVAL_MS = Math.max(1000, Number(process.env.BALL_INTERVAL_MS || 6000));
const RESULT_SECONDS = 10;

function shuffledSample(min, max, count) {
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  for (let i = values.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values.slice(0, count).sort((a, b) => a - b);
}
function cryptoRandomInt(max) {
  return require("crypto").randomInt(max);
}
function makeCard() {
  const cols = [
    shuffledSample(1, 15, 5),
    shuffledSample(16, 30, 5),
    shuffledSample(31, 45, 5),
    shuffledSample(46, 60, 5),
    shuffledSample(61, 75, 5)
  ];
  const card = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => cols[c][r]));
  card[2][2] = 0;
  return card;
}
function isWinner(card, called) {
  const hit = (r, c) => card[r][c] === 0 || called.has(card[r][c]);
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every(c => hit(r,c))) return true;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => hit(r,c))) return true;
  if ([0,1,2,3,4].every(i => hit(i,i))) return true;
  if ([0,1,2,3,4].every(i => hit(i,4-i))) return true;
  return hit(0,0) && hit(0,4) && hit(4,0) && hit(4,4);
}

async function gameTick() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(782341)");
    let result = await client.query("SELECT * FROM game_rounds ORDER BY id DESC LIMIT 1 FOR UPDATE");
    let round = result.rows[0];
    const now = Date.now();

    if (!round || (round.status === "completed" && (!round.display_until || new Date(round.display_until).getTime() <= now))) {
      result = await client.query(
        "INSERT INTO game_rounds(status,countdown_ends_at) VALUES ('waiting', NOW() + ($1 * INTERVAL '1 second')) RETURNING *",
        [COUNTDOWN_SECONDS]
      );
      round = result.rows[0];
    } else if (round.status === "waiting" && new Date(round.countdown_ends_at).getTime() <= now) {
      await client.query("UPDATE game_rounds SET status='drawing',started_at=NOW() WHERE id=$1", [round.id]);
      await drawNextBall(client, round.id);
    } else if (round.status === "drawing") {
      const lastAt = round.last_ball_at ? new Date(round.last_ball_at).getTime() : new Date(round.started_at).getTime();
      if (now - lastAt >= BALL_INTERVAL_MS) await drawNextBall(client, round.id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Game engine tick failed:", error.message);
  } finally {
    client.release();
  }
}

async function drawNextBall(client, roundId) {
  const existing = await client.query("SELECT number FROM drawn_balls WHERE round_id=$1", [roundId]);
  const used = new Set(existing.rows.map(r => Number(r.number)));
  const remaining = Array.from({length:75}, (_,i) => i+1).filter(n => !used.has(n));
  if (!remaining.length) {
    await client.query("UPDATE game_rounds SET status='completed',winners='[]'::jsonb,display_until=NOW()+($2 * INTERVAL '1 second'),completed_at=NOW() WHERE id=$1", [roundId, RESULT_SECONDS]);
    return;
  }

  const number = remaining[require("crypto").randomInt(remaining.length)];
  await client.query(
    "INSERT INTO drawn_balls(round_id,number,draw_order) VALUES($1,$2,$3)",
    [roundId, number, used.size + 1]
  );
  await client.query("UPDATE game_rounds SET last_ball_at=NOW() WHERE id=$1", [roundId]);

  const balls = new Set([...used, number]);
  const tickets = await client.query(
    "SELECT t.id,t.card_number,t.card,t.user_id,u.telegram_id,u.first_name FROM round_tickets t JOIN users u ON u.id=t.user_id WHERE t.round_id=$1 ORDER BY t.id",
    [roundId]
  );
  const winners = tickets.rows.filter(t => isWinner(t.card, balls));
  if (winners.length) {
    const sold = await client.query("SELECT COUNT(*)::int AS n FROM round_tickets WHERE round_id=$1", [roundId]);
    const poolCents = Number(sold.rows[0].n) * TICKET_PRICE_CENTS;
    const winnerFund = Math.floor(poolCents * 0.80);
    const each = Math.floor(winnerFund / winners.length);
    const totalPaid = each * winners.length;
    for (const w of winners) {
      await client.query("UPDATE users SET wallet_cents=wallet_cents+$1 WHERE id=$2", [each, w.user_id]);
      await client.query(
        "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'prize',$2,$3,$4)",
        [w.user_id, each, `round-${roundId}-ticket-${w.id}`, `Prize for Cartela #${w.card_number}`]
      );
    }
    const publicWinners = winners.map(w => ({
      name: w.first_name || "Player",
      cardNumber: Number(w.card_number),
      prizeCents: each
    }));
    await client.query(
      "UPDATE game_rounds SET status='completed',winners=$2::jsonb,prize_pool_cents=$3,house_cents=$4,display_until=NOW()+($5 * INTERVAL '1 second'),completed_at=NOW() WHERE id=$1",
      [roundId, JSON.stringify(publicWinners), poolCents, poolCents-totalPaid, RESULT_SECONDS]
    );
  } else if (used.size + 1 >= 75) {
    await client.query("UPDATE game_rounds SET status='completed',winners='[]'::jsonb,display_until=NOW()+($2 * INTERVAL '1 second'),completed_at=NOW() WHERE id=$1", [roundId, RESULT_SECONDS]);
  }
}

async function buyTicket(telegramId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query("SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE", [String(telegramId)]);
    const user = userResult.rows[0];
    if (!user) throw new Error("USER_NOT_FOUND");
    const roundResult = await client.query("SELECT * FROM game_rounds WHERE status='waiting' ORDER BY id DESC LIMIT 1 FOR UPDATE");
    const round = roundResult.rows[0];
    if (!round || new Date(round.countdown_ends_at).getTime() <= Date.now()) throw new Error("ROUND_CLOSED");
    if (Number(user.wallet_cents) < TICKET_PRICE_CENTS) throw new Error("INSUFFICIENT_BALANCE");

    const occupied = await client.query("SELECT card_number FROM round_tickets WHERE round_id=$1", [round.id]);
    const used = new Set(occupied.rows.map(r => Number(r.card_number)));
    const available = Array.from({length:600}, (_,i) => i+1).filter(n => !used.has(n));
    if (!available.length) throw new Error("ROOM_FULL");
    const cardNumber = available[require("crypto").randomInt(available.length)];
    const card = makeCard();

    await client.query("UPDATE users SET wallet_cents=wallet_cents-$1 WHERE id=$2", [TICKET_PRICE_CENTS,user.id]);
    const ticket = await client.query(
      "INSERT INTO round_tickets(round_id,user_id,card_number,card) VALUES($1,$2,$3,$4::jsonb) RETURNING id,card_number,card",
      [round.id,user.id,cardNumber,JSON.stringify(card)]
    );
    await client.query(
      "INSERT INTO wallet_transactions(user_id,type,amount_cents,reference,note) VALUES($1,'ticket_purchase',$2,$3,$4)",
      [user.id,-TICKET_PRICE_CENTS,`ticket-${ticket.rows[0].id}`,`Cartela #${cardNumber}`]
    );
    await client.query("COMMIT");
    return { ticket: ticket.rows[0], balanceCents: Number(user.wallet_cents)-TICKET_PRICE_CENTS };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getGameState(user) {
  const [roundResult,walletResult] = await Promise.all([
    pool.query("SELECT * FROM game_rounds ORDER BY id DESC LIMIT 1"),
    pool.query("SELECT wallet_cents FROM users WHERE id=$1",[user.id])
  ]);
  const round = roundResult.rows[0] || null;
  if (!round) return {round:null,tickets:[],balls:[],balanceCents:Number(walletResult.rows[0]?.wallet_cents||0)};
  const [tickets,balls,sold] = await Promise.all([
    pool.query("SELECT id,card_number,card FROM round_tickets WHERE round_id=$1 AND user_id=$2 ORDER BY id",[round.id,user.id]),
    pool.query("SELECT number FROM drawn_balls WHERE round_id=$1 ORDER BY draw_order",[round.id]),
    pool.query("SELECT COUNT(*)::int AS n FROM round_tickets WHERE round_id=$1",[round.id])
  ]);
  let countdown = null;
  if (round.status === "waiting") countdown = Math.max(0,Math.ceil((new Date(round.countdown_ends_at)-Date.now())/1000));
  if (round.status === "completed" && round.display_until) countdown = Math.max(0,Math.ceil((new Date(round.display_until)-Date.now())/1000));
  return {
    round:{id:round.id,status:round.status,countdown,sold:sold.rows[0].n,winners:round.winners||[],prizePoolCents:Number(round.prize_pool_cents||0),houseCents:Number(round.house_cents||0)},
    tickets:tickets.rows.map(t=>({id:t.id,cardNumber:t.card_number,card:t.card})),
    balls:balls.rows.map(r=>Number(r.number)),
    balanceCents:Number(walletResult.rows[0]?.wallet_cents||0)
  };
}
module.exports = {gameTick,buyTicket,getGameState,TICKET_PRICE_CENTS,COUNTDOWN_SECONDS,BALL_INTERVAL_MS};

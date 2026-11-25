CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL DEFAULT 'Player',
  username TEXT,
  wallet_cents BIGINT NOT NULL DEFAULT 0 CHECK (wallet_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS game_rounds (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('waiting','drawing','completed')),
  countdown_ends_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  last_ball_at TIMESTAMPTZ,
  winners JSONB NOT NULL DEFAULT '[]'::jsonb,
  prize_pool_cents BIGINT NOT NULL DEFAULT 0,
  house_cents BIGINT NOT NULL DEFAULT 0,
  display_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS round_tickets (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES game_rounds(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  card_number INTEGER NOT NULL CHECK (card_number BETWEEN 1 AND 600),
  card JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(round_id, card_number)
);
CREATE TABLE IF NOT EXISTS drawn_balls (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES game_rounds(id),
  number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 75),
  draw_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(round_id, number),
  UNIQUE(round_id, draw_order)
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS payment_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  method TEXT NOT NULL CHECK (method IN ('telebirr','cbe')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  sender_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_telegram_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS round_tickets_round_idx ON round_tickets(round_id);
CREATE INDEX IF NOT EXISTS drawn_balls_round_idx ON drawn_balls(round_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests(status, created_at);

ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS payout_account TEXT;

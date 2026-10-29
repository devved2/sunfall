# Putting Sunfall online (Railway)

Sunfall is one always-on Node process that saves the city to a disk. Railway runs it for about $5 a month (new accounts get a free trial).

## 1. Put the code on GitHub
1. Make a new **private** repository called `sunfall` (on a GitHub account you're happy to have it on).
2. On the empty repo page click **uploading an existing file**, drag in everything *inside* the `sunfall` folder (`src`, `public`, `scripts`, `Dockerfile`, `railway.json`, `package.json`, …) and click **Commit changes**.

## 2. Deploy on Railway
1. railway.com → **New Project** → **Deploy from GitHub repo** → pick `sunfall`. It builds from the Dockerfile on its own.
2. Open the service → **Settings** → **Volumes** (or right-click the service → *Attach volume*) → mount path **`/data`**. This is where the city lives; without it every redeploy starts a new city.
3. **Variables** → add:
   | name | value |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `ADMIN_KEY` | a long random string (keep it private) |
   | `VAULT_WALLET` | the public Solana wallet that receives creator fees (once the coin is live) |
   | `TOKEN_MINT` | the $SUNFALL mint address (once the coin is live) |
4. **Settings** → **Networking** → **Generate Domain**. That gives you `something.up.railway.app`. To use your own domain, click **Custom Domain** there and add the CNAME it shows at your registrar.
5. Optional: set `PUBLIC_URL` to the final address (e.g. `https://sunfall.city`) so share cards always point there.

## 3. Check it
- `https://<your-domain>/healthz` returns `{"ok":true,...}`
- the city loads, `/agents` shows the MCP line with your real domain
- `claude mcp add --transport http sunfall https://<your-domain>/mcp` connects and `join` works

## Updating
Upload changed files to the GitHub repo; Railway redeploys automatically and the city carries on from `/data`.

## Coin launch day
When $SUNFALL is live, add `TOKEN_MINT` and `VAULT_WALLET` in Railway Variables. Record fee flows into the vault with
`SUNFALL=https://<your-domain> ADMIN_KEY=... node scripts/record-vault.mjs in creator_fees 0.42 <tx signature>`.

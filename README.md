# Octra Intents API

Backend API untuk intent-based swap OCT ⇄ ETH dengan dynamic oracle pricing.

## Fitur

- Bidirectional swaps: OCT → ETH dan ETH → OCT
- Dynamic oracle pricing berdasarkan volume trading
- SQLite persistence untuk swap history
- Input validation dan security checks
- Liquidity monitoring dengan auto-retry
- CORS whitelist support
- Swap limits (min/max)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env dengan konfigurasi Anda
npm run dev
```

## Konfigurasi

### Environment Variables

| Variable | Deskripsi | Default |
|----------|-----------|---------|
| `PORT` | Server port | `3001` |
| `OCTRA_RPC_URL` | Octra RPC endpoint | `https://octra.network` |
| `OCTRA_ESCROW_ADDRESS` | OCT escrow address | - |
| `OCTRA_PRIVATE_KEY` | Base64 encoded private key (untuk ETH→OCT) | - |
| `SEPOLIA_RPC_URL` | Sepolia RPC endpoint | - |
| `SEPOLIA_PRIVATE_KEY` | ETH hot wallet private key | - |
| `SEPOLIA_ESCROW_ADDRESS` | ETH escrow address (untuk ETH→OCT) | - |

### Oracle Configuration

| Variable | Deskripsi | Default |
|----------|-----------|---------|
| `ORACLE_INITIAL_RATE` | Initial OCT/ETH rate | `0.001` |
| `ORACLE_ADJUSTMENT_FACTOR` | % adjustment per threshold | `0.01` (1%) |
| `ORACLE_VOLUME_THRESHOLD` | OCT volume trigger | `100` |
| `ORACLE_MAX_ADJUSTMENT` | Max % deviation | `0.10` (10%) |
| `ORACLE_WINDOW_HOURS` | Volume window duration | `1` |
| `ORACLE_MIN_RATE_PERCENT` | Min rate % of initial | `50` |
| `ORACLE_MAX_RATE_PERCENT` | Max rate % of initial | `200` |

### Security Configuration

| Variable | Deskripsi | Default |
|----------|-----------|---------|
| `FEE_BPS` | Fee dalam basis points | `50` (0.5%) |
| `MIN_SWAP_OCT` | Minimum OCT swap | `1` |
| `MAX_SWAP_OCT` | Maximum OCT swap | `100000` |
| `MIN_SWAP_ETH` | Minimum ETH swap | `0.0001` |
| `MAX_SWAP_ETH` | Maximum ETH swap | `10` |
| `DEBUG_MODE` | Enable debug endpoints | `false` |
| `ALLOWED_ORIGINS` | CORS whitelist (comma-separated) | `` (all) |

## API Endpoints

### Quote

**GET /quote** - Get swap quote dengan liquidity check.

```bash
# OCT → ETH
curl "http://localhost:3001/quote?from=OCT&to=ETH&amount=100"

# ETH → OCT
curl "http://localhost:3001/quote?from=ETH&to=OCT&amount=0.01"

# Dengan custom slippage (default 50 bps = 0.5%)
curl "http://localhost:3001/quote?from=OCT&to=ETH&amount=100&slippageBps=100"
```

### Swap Endpoints

**POST /swap/oct-to-eth** - Submit OCT → ETH swap.

```bash
curl -X POST http://localhost:3001/swap/oct-to-eth \
  -H "Content-Type: application/json" \
  -d '{"octraTxHash": "abc123..."}'
```

**POST /swap/eth-to-oct** - Submit ETH → OCT swap.

```bash
curl -X POST http://localhost:3001/swap/eth-to-oct \
  -H "Content-Type: application/json" \
  -d '{"sepoliaTxHash": "0x..."}'
```

**GET /swap/:intentId** - Get swap status.

### Oracle Endpoints

**GET /oracle/price** - Get current exchange rate.

**GET /oracle/price/history** - Get price history.

**GET /oracle/stats** - Get oracle statistics.

### Other Endpoints

**GET /liquidity** - Check escrow liquidity.

**GET /explorer** - Public swap explorer dengan pagination.

**GET /history/:address** - Get swap history untuk address.

**GET /health** - Health check.

### Proxy Endpoints (CORS bypass)

- `GET /octra/tx/:txHash` - Octra transaction details
- `GET /octra/status` - Octra chain status
- `GET /sepolia/tx/:txHash` - Sepolia transaction details
- `GET /sepolia/tx/:txHash/status` - Sepolia tx receipt status
- `GET /sepolia/balance/:address` - ETH balance

## Swap Flow

### OCT → ETH
1. Frontend call `/quote?from=OCT&to=ETH&amount=X`
2. User sign intent di wallet
3. Wallet kirim OCT ke escrow dengan payload di message
4. Frontend call `/swap/oct-to-eth` dengan `octraTxHash`
5. Backend verify on-chain, kirim ETH ke target
6. Frontend poll `/swap/:intentId` untuk status

### ETH → OCT
1. Frontend call `/quote?from=ETH&to=OCT&amount=X`
2. User sign intent di wallet
3. Wallet kirim ETH ke escrow dengan payload di `tx.data`
4. Frontend call `/swap/eth-to-oct` dengan `sepoliaTxHash`
5. Backend verify on-chain, kirim OCT ke target
6. Frontend poll `/swap/:intentId` untuk status

## Intent Status

| Status | Deskripsi |
|--------|-----------|
| `OPEN` | Intent valid, sedang diproses |
| `PENDING` | Menunggu liquidity (auto-retry 30s) |
| `FULFILLED` | Swap berhasil |
| `EXPIRED` | Intent expired |
| `REJECTED` | Validasi gagal |
| `FAILED` | Fulfillment gagal |

## Project Structure

```
src/
├── index.ts      # Entry point, Express server
├── config.ts     # Environment configuration
├── db.ts         # SQLite database operations
├── routes.ts     # API route handlers
├── solver.ts     # Intent processing & fulfillment
├── oracle.ts     # Dynamic pricing oracle
├── octra.ts      # Octra chain operations
├── sepolia.ts    # Sepolia ETH operations
├── store.ts      # Intent store (SQLite wrapper)
└── types.ts      # TypeScript type definitions
```

## Development

```bash
npm run dev      # Development dengan hot reload
npm run build    # Build
npm start        # Production
npm run lint     # Lint
```

## License

MIT

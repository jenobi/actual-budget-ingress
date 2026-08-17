# Actual Budget Ingress Gateway

A lightweight Express.js bridge service designed to ingest automated transaction payloads and safely write them to an [Actual Budget](https://actualbudget.org/) instance. It features an in-memory queue (`async-mutex`) to serialize incoming concurrent webhooks, a persistent session manager to reduce sync overhead, and deterministic deduplication.

---

## Features

* **Concurrency Control:** Utilizes `async-mutex` to process inbound HTTP requests sequentially, preventing SQLite lock contention and database write collisions.
* **Persistent API Session:** Reuses an active budget file connection across requests with automatic health checks and recovery.
* **Deduplication:** Scans recent transactions using a deterministic `messageId` primary key to avoid duplicate entries.
* **Double-Entry Transfers:** Supports linked internal transfers (`type: "internal_transfer"`) by automatically resolving system-managed transfer payees and creating inverted legs.
* **Flexible Account Resolution:** Resolves target accounts via exact string matching, fuzzy matching (`.includes`), or a configurable default fallback.
* **Security:** Optional API key authorization header (`X-Api-Key`).

---

## Environment Variables

Configure the container or service using the following environment variables:

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | No | `3000` | Port for the Express gateway server to listen on. |
| `LOG_LEVEL` | No | `info` | Output verbosity: `debug`, `info`, `warn`, or `error`. |
| `ACTUAL_SERVER_URL` | **Yes** | — | Fully qualified URL of your Actual Budget server. |
| `ACTUAL_PASSWORD` | **Yes** | — | Password used to authenticate with your Actual Budget server. |
| `ACTUAL_SYNC_ID` | **Yes** | — | Budget Sync ID (found in Actual Budget settings). |
| `ACTUAL_DATA_DIR` | No | `/tmp/actual-api-data` | Local directory path to store cached budget sqlite files. |
| `INGRESS_API_KEY` | No | — | Secret token enforced via the `X-Api-Key` request header. |
| `DEFAULT_ACCOUNT` | No | `""` | Fallback account friendly name if target account resolution fails. |
| `TRANSACTION_NOTE` | No | `🤖 Automated Entry` | Default note appended to injected transactions. |

---

## API Specification

### Endpoint
`POST /transaction`

### Headers
```http
Content-Type: application/json
X-Api-Key: <your_secret_api_key>
```

### Standard Transaction Payload
```json
{
  "messageId": "msg-2026-0817-001",
  "transaction": {
    "date": "2026-08-17",
    "amount": -1250,
    "payee": "Coffee Shop",
    "targetAccount": "Checking",
    "type": "standard"
  }
}
```

### Internal Transfer Payload
```json
{
  "messageId": "msg-2026-0817-002",
  "transaction": {
    "date": "2026-08-17",
    "amount": 50000,
    "payee": "Savings",
    "targetAccount": "Checking",
    "type": "internal_transfer"
  }
}
```

*Note: Amounts are in cents/integers matching Actual API format (e.g., `-1250` = -$12.50, `50000` = +$500.00).*

---

## Local Setup & Development

### Prerequisites
* **Node.js:** v22.0.0 or higher
* **npm:** v10.0.0 or higher

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/<your-user>/actual-budget-ingress.git
   cd actual-budget-ingress
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory:
   ```env
   PORT=3000
   LOG_LEVEL=debug
   ACTUAL_SERVER_URL=http://127.0.0.1:5006
   ACTUAL_PASSWORD=your_password
   ACTUAL_SYNC_ID=your_sync_id
   INGRESS_API_KEY=your_api_key
   DEFAULT_ACCOUNT=Checking
   ```

4. Start the server:
   ```bash
   node --env-file=.env index.js
   ```

---

## Docker / Unraid Deployment

### Build Image
```bash
docker build -t actual-budget-ingress:latest .
```

### Run Container
```bash
docker run -d \
  --name actual-budget-ingress \
  -p 3000:3000 \
  -e ACTUAL_SERVER_URL="http://192.168.1.100:5006" \
  -e ACTUAL_PASSWORD="your_password" \
  -e ACTUAL_SYNC_ID="your_sync_id" \
  -e INGRESS_API_KEY="your_api_key" \
  -e DEFAULT_ACCOUNT="Checking" \
  -v /mnt/user/appdata/actual-ingress:/tmp/actual-api-data \
  --restart unless-stopped \
  actual-budget-ingress:latest
```

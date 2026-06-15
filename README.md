# Vehicle LPR Backend

Production-ready Express + MongoDB backend for a License Plate Recognition (LPR) parking/gate management system. Receives vehicle detection events from an Intozi AI camera server and exposes dashboard APIs to manage vehicles, cameras, and logs.

## Setup

```bash
npm install express mongoose dotenv cors
cp .env.example .env        # then edit values
node index.js
```

### Environment variables (`.env`)

| Variable         | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `PORT`           | HTTP port (default 5000)                             |
| `MONGO_URI`      | MongoDB connection string                            |
| `INTOZI_API_KEY` | Shared secret Intozi must send in `x-api-key` header |

## Endpoints

### Health
- `GET /health`

### Intozi receiver (requires `x-api-key` header)
- `POST /api/intozi/event` — receives a detection event. Idempotent on `transaction_id`; resolves `event_type` (entry/exit/unknown) from camera config; always returns 200 on success.

### Logs (dashboard)
- `GET /api/logs` — paginated list (excludes images). Filters: `vehicle_number`, `event_type`, `from`, `to`, `page`, `limit`.
- `GET /api/logs/:id` — full document including base64 images.
- `DELETE /api/logs/:id`

### Vehicles (dashboard)
- `GET /api/vehicles`
- `POST /api/vehicles` — `{ vehicle_number, owner_name, vehicle_class, notes }`
- `DELETE /api/vehicles/:id`

### Cameras (dashboard)
- `GET /api/cameras`
- `POST /api/cameras` — upsert `{ cam_id, device_name, gate_type: "entry"|"exit", location }`
- `DELETE /api/cameras/:id`

## Quick test

```bash
# Register a camera as an entry gate
curl -X POST http://localhost:5000/api/cameras \
  -H "Content-Type: application/json" \
  -d '{"cam_id":3,"device_name":"Intozi_Camera_1","gate_type":"entry","location":"Main Gate"}'

# Simulate an Intozi event
curl -X POST http://localhost:5000/api/intozi/event \
  -H "Content-Type: application/json" \
  -H "x-api-key: change-me-to-a-long-random-secret" \
  -d '{"transaction_id":108,"cam_id":3,"vehicle_number":"MH12AB1234","vehicle_class":"car","created_datetime":"2025-12-22T12:33:01.744613"}'

# View logs
curl http://localhost:5000/api/logs
```

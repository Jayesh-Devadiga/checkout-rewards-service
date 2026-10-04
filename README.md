# Checkout and Rewards Service

Backend for a small store: carts, checkout, orders, inventory and discount coupons.

**Status: in progress.** The work lands in small slices and this README grows with it. So far: project setup, database migrations, seed data, the product list, carts, checkout, orders, coupons and the API docs page. The report is still to come.

The design choices and the reasons for them are in [DECISIONS.md](DECISIONS.md).

## Requirements

- Node.js 22.12 or newer
- Docker, for PostgreSQL 16

## Run it locally

```
docker compose up -d --wait db
npm install
npm run migrate
npm run seed
npm run dev
```

Then open http://localhost:3000/docs for the API docs.

- `npm run migrate` applies the SQL files in `migrations/` that have not run yet.
- `npm run seed` inserts six products. It is safe to run again. It never changes a product that already exists.

## Tests

```
docker compose up -d --wait db
npm test
```

The tests run against a real PostgreSQL database. They use their own database, `checkout_test`, on the same server. It is dropped and recreated at the start of every run, so the tests never touch the data you see when running the service.

## Configuration

All settings are environment variables. They are checked at startup, and the service refuses to start if one is invalid.

The defaults work with `docker-compose.yml` as it is, so no `.env` file is needed. To change a setting, copy `.env.example` to `.env` and edit it:

```
copy .env.example .env      (Windows)
cp .env.example .env        (macOS, Linux)
```

The service, `npm run migrate`, `npm run seed` and `npm test` all read `.env` if it exists. A variable set in the real environment wins over the file. `.env` is not committed.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the service listens on |
| `DATABASE_URL` | `postgres://checkout:checkout@localhost:5433/checkout` | PostgreSQL connection |
| `COUPON_EVERY_N_ORDERS` | `5` | n. A coupon becomes available at every nth placed order. Whole number, 1 or more. |
| `COUPON_DISCOUNT_PERCENT` | `10` | x. Percent off for each generated coupon. Whole number, 1 to 100. |
| `TEST_DATABASE_URL` | `postgres://checkout:checkout@localhost:5433/checkout_test` | Database used by `npm test`. Its name must end in `_test`. |

## Endpoints so far

| Call | What it does |
|---|---|
| `GET /health` | Checks the service and its database |
| `GET /products` | Lists products with current price and stock |
| `POST /carts` | Creates an empty cart |
| `GET /carts/{cartId}` | Shows the cart with current prices, totals and stock |
| `PUT /carts/{cartId}/items/{productId}` | Adds a product or changes its quantity. Body: `{ "quantity": 2 }` |
| `DELETE /carts/{cartId}/items/{productId}` | Removes a product from the cart |
| `POST /carts/{cartId}/checkout` | Places the order. Optional body: `{ "coupon_code": "K7M2Q9XDPA", "accept_price_changes": true }`. Safe to retry: a second call returns the same order. |
| `GET /orders/{orderId}` | Shows an order with its lines and totals |
| `POST /admin/coupons` | Administrative. Generates the next coupon that is owed. A coupon is owed at every nth placed order. |
| `GET /admin/coupons` | Administrative. Lists every coupon and whether it has been used |
| `PATCH /admin/products/{productId}` | Administrative. Changes a product's price or stock. Body: `{ "price_paise": 69900 }`, `{ "stock": 50 }` or both |
| `GET /docs` | Swagger UI, with every request, response and error |
| `GET /docs.json` | The OpenAPI document |

Money is always whole paise. `64900` means Rs 649.00.

Every error has the same shape: `{ "error": { "code", "message", "details" } }`.

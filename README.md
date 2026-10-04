# Checkout and Rewards Service

Backend for a small store: products, carts, checkout, orders, stock and discount coupons.

The endpoints are simple. The work is in what happens when requests overlap or are sent twice:

- Stock is never oversold, even when many carts check out at the same moment.
- A cart gives at most one order. A retried checkout returns the same order and takes no more stock.
- A coupon is used at most once. A checkout that fails does not use it up.
- Each order milestone gives at most one coupon.
- A checkout that fails changes nothing.

How each of these is enforced, and what I chose where the requirements were open, is in [DECISIONS.md](DECISIONS.md).

## Run it

You need Docker. Nothing else.

```
docker compose up --build --wait
```

This starts PostgreSQL, builds the service, applies the database migrations, inserts six products and starts the service. The command returns once the service answers.

- API docs, with a "Try it out" button on every endpoint: http://localhost:3000/docs
- The same docs as an OpenAPI document: http://localhost:3000/docs.json

```
docker compose logs app     the service's output
docker compose down -v      stop everything and remove the database
```

The database lives inside its container. After `docker compose down -v`, the next start begins with a fresh store and the six seed products.

If port 3000 is taken on your machine, see [Configuration](#configuration).

## Try it

The seed products:

| id | Name | Price | Stock |
|---|---|---|---|
| 1 | Basmati Rice 5 kg | Rs 649.00 | 100 |
| 2 | Toor Dal 1 kg | Rs 189.50 | 80 |
| 3 | Filter Coffee Powder 500 g | Rs 325.00 | 50 |
| 4 | Coconut Oil 1 L | Rs 410.00 | 40 |
| 5 | Steel Water Bottle 1 L | Rs 499.99 | 25 |
| 6 | Brass Lamp (limited stock) | Rs 2499.00 | 3 |

The calls below are written for a bash shell. On Windows, use Git Bash, or make the same calls from the docs page.

```bash
# 1. Create a cart. The answer has its "id".
curl -s -X POST http://localhost:3000/carts
CART=paste-the-id-here

# 2. Put 2 units of product 1 in it.
curl -s -X PUT http://localhost:3000/carts/$CART/items/1 \
  -H "Content-Type: application/json" -d '{"quantity": 2}'

# 3. Look at the cart: prices, line totals, subtotal and stock.
curl -s http://localhost:3000/carts/$CART

# 4. Check out. Status 201, and the answer is the order.
curl -s -i -X POST http://localhost:3000/carts/$CART/checkout

# 5. Send the same call again, as a client would after a timeout.
#    Status 200, the same order id, and the stock is not taken twice.
curl -s -i -X POST http://localhost:3000/carts/$CART/checkout
curl -s http://localhost:3000/products

# 6. Ask for a coupon. One order is placed and the first coupon is earned
#    at order 5, so this is refused: 409 NO_ELIGIBLE_MILESTONE.
curl -s -X POST http://localhost:3000/admin/coupons

# 7. The report.
curl -s http://localhost:3000/admin/report
```

To see a coupon work, place four more orders (steps 1, 2 and 4 with new carts). Step 6 then returns a coupon with a `code`. Use it on the next cart:

```bash
curl -s -X POST http://localhost:3000/carts/$CART/checkout \
  -H "Content-Type: application/json" -d '{"coupon_code": "PASTE-THE-CODE"}'
```

A second checkout with the same code is refused with 409 `COUPON_ALREADY_REDEEMED`.

## Tests

The tests run against a real PostgreSQL database, because the guards being tested are database statements, locks and constraints. They use their own database, `checkout_test`. It is dropped and recreated at the start of every run, so the tests never touch the data you see when running the service.

With Docker only:

```
docker compose run --rm --build test
```

With Node.js 22.12 or newer on your machine:

```
docker compose up -d --wait db
npm install
npm test
```

There are about 190 tests and they take around 15 seconds.

Tests to read first, since they are the ones with competing or repeated requests:

| File | Test |
|---|---|
| `test/checkout.test.ts` | sells the last 3 units to exactly 3 of 10 carts |
| `test/checkout.test.ts` | creates one order when the same cart is checked out 5 times at once |
| `test/checkout.test.ts` | does not deadlock when carts hold the same products added in opposite order |
| `test/checkout.test.ts` | never leaves a line in a checked-out cart that is missing from its order |
| `test/coupons.test.ts` | lets exactly one of 5 concurrent checkouts redeem it |
| `test/coupons.test.ts` | stays available when the checkout fails on stock, and works afterwards |
| `test/coupons.test.ts` | gives each owed milestone to one caller when 4 admins ask at once |
| `test/report.test.ts` | always adds up, whatever moment it is taken |
| `test/report.test.ts` | reconciles with the orders and coupons the API returns |

## Run it for development

This runs the service on your machine with reload on save. Only the database runs in Docker.

```
docker compose up -d --wait db
npm install
npm run migrate
npm run seed
npm run dev
```

- `npm run migrate` applies the SQL files in `migrations/` that have not run yet.
- `npm run seed` inserts the six products. It is safe to run again. It never changes a product that already exists.

Do not run this at the same time as the full `docker compose up`. Both want port 3000.

## Configuration

All settings are environment variables. They are checked at startup, and the service refuses to start if one is invalid.

The defaults work as they are, so no `.env` file is needed. To change a setting, copy `.env.example` to `.env` and edit it:

```
copy .env.example .env      (Windows)
cp .env.example .env        (macOS, Linux)
```

The service, `npm run migrate`, `npm run seed`, `npm test` and Docker Compose all read `.env` if it exists. A variable set in the real environment wins over the file. `.env` is not committed.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the service listens on |
| `DATABASE_URL` | `postgres://checkout:checkout@localhost:5433/checkout` | PostgreSQL connection |
| `COUPON_EVERY_N_ORDERS` | `5` | n. A coupon becomes available at every nth placed order. Whole number, 1 or more. |
| `COUPON_DISCOUNT_PERCENT` | `10` | x. Percent off for each generated coupon. Whole number, 1 to 100. |
| `TEST_DATABASE_URL` | `postgres://checkout:checkout@localhost:5433/checkout_test` | Database used by `npm test`. Its name must end in `_test`. |

When the service runs in Docker Compose, `PORT` is the port on your machine, and the two database addresses are set by `docker-compose.yml`. `n` and `x` are read at startup, so restart the service after changing them:

```
docker compose up --build --wait
```

## Endpoints

The full description of every request, response and error is on the docs page. This is the short version.

There is no authentication. The routes under `/admin` are the administrative ones.

| Call | What it does | Success | Errors |
|---|---|---|---|
| `GET /products` | Lists products with current price and stock | 200 | |
| `POST /carts` | Creates an empty cart | 201 | |
| `GET /carts/{cartId}` | Shows the cart with prices, totals and stock | 200 | 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND` |
| `PUT /carts/{cartId}/items/{productId}` | Adds a product or changes its quantity. Body: `{ "quantity": 2 }` | 200 | 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND`, 404 `PRODUCT_NOT_FOUND`, 409 `CART_ALREADY_CHECKED_OUT`, 409 `INSUFFICIENT_STOCK` |
| `DELETE /carts/{cartId}/items/{productId}` | Removes a product from the cart | 200 | 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND`, 409 `CART_ALREADY_CHECKED_OUT` |
| `POST /carts/{cartId}/checkout` | Places the order. Optional body: `{ "coupon_code": "K7M2Q9XDPA", "accept_price_changes": true }` | 201 for a new order, 200 for a retry | 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND`, 404 `COUPON_NOT_FOUND`, 409 `CART_EMPTY`, 409 `COUPON_ALREADY_REDEEMED`, 409 `INSUFFICIENT_STOCK`, 409 `PRICE_CHANGED`, 409 `CART_ALREADY_CHECKED_OUT` |
| `GET /orders/{orderId}` | Shows an order with its lines and totals | 200 | 400 `VALIDATION_ERROR`, 404 `ORDER_NOT_FOUND` |
| `POST /admin/coupons` | Administrative. Generates the next coupon that is owed. A coupon is owed at every nth placed order. | 201 | 409 `NO_ELIGIBLE_MILESTONE` |
| `GET /admin/coupons` | Administrative. Lists every coupon and whether it has been used | 200 | |
| `GET /admin/report` | Administrative. Orders, quantities by product, gross and net revenue, discounts and coupon counts | 200 | |
| `PATCH /admin/products/{productId}` | Administrative. Changes a product's price or stock. Body: `{ "price_paise": 69900 }`, `{ "stock": 50 }` or both | 200 | 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND` |
| `GET /health` | Checks the service and its database | 200 | |
| `GET /docs` | Swagger UI | 200 | |
| `GET /docs.json` | The OpenAPI document | 200 | |

Three things hold for every endpoint:

- Money is always whole paise. `64900` means Rs 649.00.
- Every error has the same shape: `{ "error": { "code", "message", "details" } }`. The `code` is the value a client should switch on.
- 400 means the request is malformed. 404 means something it names does not exist. 409 means the request is fine but the current state refuses it.

## Project layout

```
migrations/         numbered SQL files, applied in order
src/
  server.ts         starts the service
  app.ts            builds the Express app, holds the error handler
  config.ts         settings from environment variables, checked at startup
  routes/           one file per group of endpoints, with the docs comments
  carts.ts          cart rules
  checkout.ts       the checkout transaction
  coupons.ts        coupon generation and milestones
  orders.ts         reading an order
  report.ts         the admin report
  money.ts          the discount calculation
  validation.ts     request checks
  errors.ts         the error type every refusal uses
  docs.ts           builds the OpenAPI document
  db/               connection pool, transactions, migration runner, seed data
  cli/              entry points for "npm run migrate" and "npm run seed"
test/               tests, run against a real PostgreSQL database
Dockerfile          builds the service image
docker-compose.yml  database, service and test runner
DECISIONS.md        invariants, design decisions and what was left out
```

The stack: TypeScript on Node.js 22, Express 5, PostgreSQL 16 with plain SQL through `pg`, Zod for request checks, Vitest and Supertest for tests.

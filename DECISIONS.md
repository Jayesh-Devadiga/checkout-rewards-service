# Decisions

This file records how I designed the service and why. It grows with the code: each part is added together with the code it explains. Parts that are not built yet are listed at the end.

## System invariants

The rules the service must never break, and where each one is enforced. The list grows as the parts are built.

1. **Stock never goes below zero.**
   In place so far: the database refuses it with `CHECK (stock >= 0)` on `products` (`migrations/001_create_products.sql`). Checkout, which is the code that takes stock, comes later and puts its own guard in front of this one. The database check stays as the backstop.
2. **The service never runs with an invalid coupon setting.**
   `n` must be a whole number of 1 or more. `x` must be a whole percent from 1 to 100. `src/config.ts` checks both at startup and the process exits if either is wrong.
3. **Only valid lines enter a cart.**
   The product must exist. The quantity must be a whole number of 1 or more, and not more than the stock at that moment. Enforced by the request checks in `src/validation.ts` and by `setCartItem` in `src/carts.ts`. Backstops in the database: the foreign key to `products` and `CHECK (quantity > 0)` on `cart_items`.
4. **A product appears at most once in a cart.**
   The primary key of `cart_items` is `(cart_id, product_id)`. Saving the same product again updates that row.
5. **A checked-out cart never changes.**
   Every cart change first locks the cart row and reads its status under that lock (`lockOpenCart` in `src/carts.ts`). A cart that is not open is refused with `CART_ALREADY_CHECKED_OUT`. Checkout, when it is built, takes the same lock, so a cart cannot be changed while it is being checked out.

## Decision: PostgreSQL, not an in-memory store

**Context:** The hard part of this assignment is overlapping requests: two checkouts for the last unit, two checkouts with the same coupon, a checkout that is retried. I needed a place where "check, then change" happens as one step.

**Options considered:**
- An in-memory store in Node. Nothing to install. But Node runs JavaScript on one thread, so races only appear where the code awaits. I would have had to build my own locks to have anything to show, and then explain separately how it would work with a real database.
- PostgreSQL. It has transactions, row locks, and unique and check constraints.

**Choice:** PostgreSQL 16, started with Docker Compose.

**Why:** The guarantees I need already exist in the database. Each invariant can point to one statement or one constraint. The same design holds when more than one copy of the service runs, because nothing important lives in process memory.

**Consequences:** The reviewer needs Docker. The tests need a real database, so they are slower than pure unit tests. In return they test the behaviour that matters here.

## Decision: Plain SQL with migration files, not an ORM

**Context:** I had to choose how the code talks to the database and how the schema and seed data are set up repeatably.

**Options considered:**
- Prisma, which I have used before. Typed queries, migrations and seeding built in.
- Drizzle. Typed queries with a lighter tool.
- Plain SQL through the `pg` driver, with numbered `.sql` files in `migrations/`, a small runner and a seed script.

**Choice:** Plain SQL. `npm run migrate` applies the files that have not run yet and records each one in `schema_migrations`. `npm run seed` inserts six products and is safe to run again.

**Why:**
- Every guard in this service is a SQL statement or a constraint. With plain SQL the code shows exactly what the database runs. Nothing has to be translated in your head.
- There are about six tables. An ORM would add tooling without removing much code.
- A practical reason: I built this with an AI assistant, and it could not run Prisma's command-line tool in its sandbox. I wanted every piece tested before it reached me for review, so that ruled Prisma out.

**Consequences:**
- No typed query builder. Row types are written by hand, and a misspelt column is caught by a test, not by the compiler.
- The migration runner is deliberately small. It applies files in name order, each in its own transaction together with the row that records it. It does not guard against two instances migrating at the same moment. In production I would run migrations as one deploy step, or use a migration tool.

## Decision: Settings are read once at startup and checked

**Context:** `n` and `x` decide when a coupon becomes available and how large its discount is. A wrong value changes what customers are given.

**Options considered:**
- Environment variables, read and checked when the service starts.
- An admin endpoint that changes them while the service runs, stored in the database.

**Choice:** Environment variables: `COUPON_EVERY_N_ORDERS` and `COUPON_DISCOUNT_PERCENT`. `src/config.ts` checks them at startup and the service refuses to start if one is invalid. For local use it also reads a `.env` file. A variable set in the real environment wins over the file.

**Why:** A wrong value should fail loudly at startup, not quietly change behaviour. `x` above 100 would make a negative total possible, so it is refused. Changing the values at runtime raises questions I did not need to take on, such as a settings change racing with a checkout.

**Consequences:** Changing `n` or `x` needs a restart. What a change in `n` means for coupons already earned is described in the coupon section, when that part is built.

## Decision: One call sets the quantity of a cart line

**Context:** The assignment asks for adding an item, changing its quantity and removing it. It also says clients may retry a request after a timeout. An "add" that increases the quantity would add twice on a retry.

**Options considered:**
- `POST` to add, which increases the quantity, and `PATCH` to change it. This matches the wording of the assignment. A retried `POST` adds twice unless extra protection is built.
- `PUT /carts/{cartId}/items/{productId}` with `{ "quantity": n }`, which sets the quantity to exactly `n`.

**Choice:** `PUT` sets the quantity. If the product is not in the cart it is added, otherwise the line is updated. `DELETE` on the same path removes the line.

**Why:** The same request sent twice gives the same cart, so a retry is safe with nothing extra to build. There is also one way to do each thing: a quantity of 0 is refused, because removing is what `DELETE` is for. Removing a line that is not there returns the cart as it is, for the same reason.

**Consequences:** There is no "add one more". The client sends the total quantity it wants. Adding and changing are the same endpoint, and the API docs say so.

## Decision: The cart records the price it showed

**Context:** The assignment says: decide and document what happens when a price changes after an item was added but before checkout. A cart can sit for hours or days. If the price changes in that time, the customer should not find out from the bill.

**Options considered:**
- Store no price in the cart and charge the current price at checkout. Simple, but the customer can pay a price they never saw.
- Freeze the price when the item is added and honour it. Kind to the customer, but the store sells at old prices, and a cart can be parked to hold a low price.
- Record the price on the cart line, show the customer when it has changed, and make them accept the new price before the order is placed.

**Choice:** The third. A cart line stores the unit price at the moment the line is saved. The cart view returns `recorded_unit_price_paise`, `current_unit_price_paise` and a `price_changed` flag for every line. Line totals and the subtotal use the current price, because that is what checkout would charge.

Saving a line again records the current price. That is how a client accepts a new price before checkout. Viewing the cart never changes anything.

The other half of this decision is at checkout: a changed price is refused unless the client says it accepts it. That part is described in the checkout section, when it is built.

**Why:** The customer is told about the change, and the store still sells at its current price.

**Consequences:** One extra column on the cart line, and the cart view does a little more work.

## Stock changes before checkout

The same sentence in the assignment also covers availability.

- Saving a line checks the quantity against the stock at that moment. Asking for more than is in stock is refused with `INSUFFICIENT_STOCK`, and the details say how many were asked for and how many are left.
- This check is a courtesy. It holds nothing. Two carts can both contain the last three units. Holding stock when an item is added would need an expiry and a cleanup job for abandoned carts, which I decided was more than this service needs.
- If stock later drops below a line's quantity, the cart view flags that line with `insufficient_stock` and shows `available_stock`, so a client can warn the customer before checkout.
- The check that really protects stock is at checkout. It is described in the checkout section, when it is built.

## Cart ids

There is no login, so the cart id is the only thing that protects a cart. Cart ids are random UUIDs and not counting numbers, so one customer cannot guess another customer's cart.

## Money and rounding rules

- Every amount is a whole number of paise (100 paise = 1 rupee). That holds in the database (`price_paise integer`), in the code and in the API. `64900` means Rs 649.00.
- There are no floating-point numbers and no decimals anywhere in the money path.
- Price times quantity, and adding lines up, is whole-number arithmetic. It never needs rounding.
- The one place a fraction can appear is a percentage discount. That rule is written in the coupon section, when that part is built.
- Limit: an integer column holds up to about Rs 2.1 crore per amount. Past that the database rejects the write. It does not wrap around.

## Error model

Every error response has one shape:

```json
{ "error": { "code": "ROUTE_NOT_FOUND", "message": "No route for GET /nope", "details": {} } }
```

- `code` is the stable value a client switches on. `message` is for a person. `details` carries extra data for that error.
- The HTTP status follows three rules:
  - **400**: the request itself is malformed.
  - **404**: something the request names does not exist.
  - **409**: the request is valid, but the current state refuses it.
- Anything unexpected returns **500** with `INTERNAL_ERROR`. The real error goes to the server log and is never sent to the client.

Codes so far:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The body is not valid JSON, a quantity is not a whole number of 1 or more, or an id in the URL is malformed. The details list what was wrong. |
| 404 | `ROUTE_NOT_FOUND` | No such route |
| 404 | `CART_NOT_FOUND` | No cart with that id |
| 404 | `PRODUCT_NOT_FOUND` | No product with that id |
| 409 | `CART_ALREADY_CHECKED_OUT` | A change was sent to a cart that has been checked out |
| 409 | `INSUFFICIENT_STOCK` | The quantity asked for is more than is in stock |
| 500 | `INTERNAL_ERROR` | Anything unexpected |

Each later part adds its own.

**Alternatives considered:**
- RFC 9457 `application/problem+json`. It is a standard, but it has more fields for the same information.
- Adding 422 for business-rule failures. That gives a fourth bucket, and the line between 409 and 422 is hard to state clearly.

## Still to come

These sections are added as the parts are built:

- Checkout: the transaction, concurrency and retries, and accepting a changed price
- Coupons and milestones, including the discount rounding rule
- The report
- Ambiguities I found and the meaning I chose
- What is implemented and what is deferred
- Multiple instances and production scale
- How I used AI
- Time spent, and what I would look at with two more hours

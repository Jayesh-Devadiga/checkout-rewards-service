# Decisions

This file records how I designed the service and why.

Where to find what the assignment asks for:

| Asked for | Where |
|---|---|
| System invariants | [System invariants](#system-invariants) |
| Ambiguities and the meaning I chose | [Ambiguities I found and the meaning I chose](#ambiguities-i-found-and-the-meaning-i-chose) |
| Material decisions and alternatives | The thirteen sections titled "Decision:" |
| Transaction, concurrency and idempotency | [Checkout: transaction, concurrency and retries](#checkout-transaction-concurrency-and-retries) and the decision after it |
| Money and rounding | [Money and rounding rules](#money-and-rounding-rules) |
| Error model | [Error model](#error-model) |
| Implemented and deferred | [What is implemented and what is deferred](#what-is-implemented-and-what-is-deferred), [Known weaknesses](#known-weaknesses) |
| Multiple instances and scale | [Multiple instances and production scale](#multiple-instances-and-production-scale) |
| Use of AI | [How I used AI](#how-i-used-ai) |
| Time spent, and two more hours | [Time spent](#time-spent), [With two more hours](#with-two-more-hours) |

## System invariants

The rules the service must never break, and where each one is enforced.

1. **Stock is never oversold and never goes below zero.**
   Checkout takes stock with one statement that checks and changes together: `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1` (`takeStock` in `src/checkout.ts`). Backstop in the database: `CHECK (stock >= 0)` on `products`. With the first guard removed as a test, ten carts raced for three units and the database check still held: stock ended at zero with three orders, and the other seven requests failed with a 500 where the real code gives a clean 409.
2. **The service never runs with an invalid coupon setting.**
   `n` must be a whole number of 1 or more. `x` must be a whole percent from 1 to 100. `src/config.ts` checks both at startup and the process exits if either is wrong.
3. **Only valid lines enter a cart.**
   The product must exist. The quantity must be a whole number of 1 or more, and not more than the stock at that moment. Enforced by the request checks in `src/validation.ts` and by `setCartItem` in `src/carts.ts`. Backstops in the database: the foreign key to `products` and `CHECK (quantity > 0)` on `cart_items`.
4. **A product appears at most once in a cart.**
   The primary key of `cart_items` is `(cart_id, product_id)`. Saving the same product again updates that row.
5. **A checked-out cart never changes.**
   Every cart change first locks the cart row and reads its status under that lock (`lockOpenCart` in `src/carts.ts`). A cart that is not open is refused with `CART_ALREADY_CHECKED_OUT`. Checkout takes the same lock, so a cart cannot be changed while it is being checked out.
6. **A cart gives at most one order.**
   Checkout locks the cart row, and closes the cart in the same transaction that writes the order. Backstop in the database: `UNIQUE (cart_id)` on `orders`.
7. **A retried checkout returns the same order and changes nothing.**
   A checkout that finds the cart already checked out returns the stored order with status 200. It takes no stock and writes nothing.
8. **A failed checkout changes nothing.**
   Checkout is one database transaction. Any failure rolls all of it back: stock taken for other lines is given back, a coupon that was claimed is available again, no order exists, and the cart is still open.
9. **An order never changes and explains itself.**
   An order stores its own copy of each product name, unit price, quantity and line total, plus subtotal, discount and total. Reading an order never touches the `products` table. The code has no statement that updates an order. Backstops in the database: `CHECK (total_paise = subtotal_paise - discount_paise)` and `CHECK (line_total_paise = unit_price_paise * quantity)`.
10. **A changed price is not charged unless the client accepts it.**
    Checkout compares the price recorded on each cart line with the current price, and refuses with `PRICE_CHANGED` unless the request says `accept_price_changes: true`. There is one known gap, described under that decision.
11. **A coupon is redeemed at most once.**
    Checkout claims a coupon with one statement that checks and changes together: `UPDATE coupons SET redeemed_at = now() WHERE code = $1 AND redeemed_at IS NULL` (`claimCoupon` in `src/checkout.ts`). Backstop in the database: `UNIQUE (coupon_id)` on `orders`, so two orders cannot point at the same coupon.
12. **A coupon is not used up by a checkout that fails.**
    The coupon is claimed inside the checkout transaction, before the stock and price steps. If a later step fails, the rollback makes the coupon available again.
13. **A milestone earns at most one coupon, and only after it is reached.**
    Coupon generation takes a lock so that calls run one at a time, then compares the next milestone with the number of orders (`generateCoupon` in `src/coupons.ts`). Backstop in the database: `UNIQUE (milestone_order_count)` on `coupons`.
14. **An order total is never negative, and a discount only exists with a coupon.**
    A coupon's percent is between 1 and 100, checked at startup and by the database. The discount is rounded down, so it is never more than the subtotal. Backstops in the database: `CHECK (total_paise >= 0)` and a check that an order without a coupon has no discount.
15. **The report only reads, and its figures agree with each other.**
    The report runs in a read-only transaction that sees one frozen picture of the database (`withReadOnlySnapshot` in `src/db/pool.ts`). The database refuses any write inside it. Net revenue is always gross minus discounts, and coupons generated is always available plus redeemed.

## Ambiguities I found and the meaning I chose

The assignment leaves these open. Each row says what I chose. The reasons are in the section named in the last column.

| Open question | What I chose | More in |
|---|---|---|
| What happens when a price changes after an item was added? | The cart line records the price it showed. The cart view flags a change. Checkout refuses a changed price until the client accepts it. | "The cart records the price it showed", "Accepting a changed price at checkout" |
| What happens when stock changes after an item was added? | Nothing is held for a cart. Stock is checked and taken at checkout. | "Stock changes before checkout" |
| One line of a cart is short on stock. Is the rest sold? | No. The whole checkout fails and lists every short line. | "Stock is taken at checkout, all or nothing" |
| What state is a cart in after a failed checkout? | Open and unchanged. The client fixes it and checks out again. | "Checkout: transaction, concurrency and retries" |
| How does the service recognise a retried checkout? | By the cart. One cart, one order. | "The cart itself makes checkout safe to retry" |
| Is a second checkout of the same cart with a different coupon a retry? | No. It is refused, and that second coupon is not touched. | Same section |
| "Add an item" and "change its quantity": two operations or one? | One call that sets the quantity, so it is safe to repeat. | "One call sets the quantity of a cart line" |
| What is a "successfully placed order" when there is no payment? | Every order that exists. A checkout creates a complete order or nothing. There are no pending or cancelled orders. | "No payment step" |
| "Every nth order": counted for the whole store, or for each customer? | The whole store. | "Coupons: what the assignment leaves open, and what I chose" |
| Is a coupon created when the milestone is reached, or when the administrator asks? | When the administrator asks. | Same section |
| Several milestones are owed. How many coupons does one call give? | One, for the lowest milestone. | Same section |
| Who may use a coupon? | Whoever holds the code, once. | Same section |
| Does an order that used a coupon count toward the next milestone? | Yes. | Same section |
| Do coupons expire? | No. | Same section |
| A coupon code is unknown or already used. Does the order go through at full price? | No. The checkout fails. | Same section |
| What does a change of `n` do to milestones? | Milestones are multiples of the current `n`, above the last one that has a coupon. | "Milestones, and what happens when n changes" |
| What does a change of `x` do to coupons that exist? | Nothing. Each coupon carries its own percent. | "Coupons: what the assignment leaves open, and what I chose" |
| When can `n` and `x` change? | Only at startup. | "Settings are read once at startup and checked" |
| How is x% rounded? | Down to the paisa, once per order. | "Money and rounding rules" |
| Which currency? | The assignment names none. I used Indian rupees, stored as whole paise. | "Money and rounding rules" |
| In the report, what is an "available" coupon? | Generated and not yet used. Milestones that are reached but have no coupon yet are shown separately as `coupons_owed`. | "The report" |
| Which operations are administrative? | Everything under `/admin`. There is no authentication, which the assignment allows. | "Known weaknesses" |

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

**Consequences:** Changing `n` or `x` needs a restart. What a change in `n` means for milestones is described under "Milestones, and what happens when n changes".

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

The other half of this decision is at checkout: a changed price is refused unless the client says it accepts it. See "Accepting a changed price at checkout" below.

**Why:** The customer is told about the change, and the store still sells at its current price.

**Consequences:** One extra column on the cart line, and the cart view does a little more work.

## Stock changes before checkout

The same sentence in the assignment also covers availability.

- Saving a line checks the quantity against the stock at that moment. Asking for more than is in stock is refused with `INSUFFICIENT_STOCK`, and the details say how many were asked for and how many are left.
- This check is a courtesy. It holds nothing. Two carts can both contain the last three units. Holding stock when an item is added would need an expiry and a cleanup job for abandoned carts, which I decided was more than this service needs.
- If stock later drops below a line's quantity, the cart view flags that line with `insufficient_stock` and shows `available_stock`, so a client can warn the customer before checkout.
- The check that really protects stock is at checkout. See "Stock is taken at checkout, all or nothing" below.

## Cart ids

There is no login, so the cart id is the only thing that protects a cart. Cart ids are random UUIDs and not counting numbers, so one customer cannot guess another customer's cart.

## Checkout: transaction, concurrency and retries

Checkout is the one place where several things must change together, so it runs as one database transaction (`checkout` in `src/checkout.ts`). The steps:

1. Lock the cart row.
2. If the cart is already checked out, return its order and stop. This is the retry case. If the request names a different coupon than that order used, refuse with `CART_ALREADY_CHECKED_OUT`.
3. Read the cart lines in product id order. No lines: `CART_EMPTY`.
4. If a coupon code was sent, claim the coupon. Unknown code: `COUPON_NOT_FOUND`. Already used: `COUPON_ALREADY_REDEEMED`.
5. Take the stock for every line. If any line is short: `INSUFFICIENT_STOCK`, listing every short product.
6. Compare each recorded price with the current price. A difference that was not accepted: `PRICE_CHANGED`.
7. Work out subtotal, discount and total.
8. Write the order and its lines.
9. Mark the cart as checked out.

If any step fails, the transaction rolls back and nothing has changed. When several things are wrong at once, the client gets the first one in this order: empty cart, then coupon, then stock, then price.

The coupon is claimed at step 4, before the steps that are most likely to fail, on purpose. It means "a failed checkout does not use up the coupon" is really exercised: the coupon is claimed, a later step fails, and the rollback hands it back.

**How overlapping requests are kept correct.** I use PostgreSQL's default isolation level (read committed). The safety does not come from a stricter level. It comes from two things:

- **Row locks.** Step 1 uses `SELECT ... FOR UPDATE` on the cart. A second request for the same cart waits there until the first one commits or rolls back, and then reads what the first one left behind.
- **Check and change in one statement.** Steps 4 and 5 do not read first and then decide. Each is an `UPDATE` that only matches a row that still qualifies: a coupon that is unused, a product that still has enough stock. The database locks that row while the statement runs. A second checkout waits for the first, re-checks against what the first one left, and matches nothing if the coupon or the stock is gone.

What happens in each overlap:

| Situation | Outcome |
|---|---|
| Ten carts check out the last 3 units at the same moment | Exactly 3 orders. The other 7 get `INSUFFICIENT_STOCK`, their carts stay open, stock ends at 0. |
| The same cart is checked out twice at the same moment | The second waits at step 1, then finds the cart checked out and returns the first one's order with 200. One order, stock taken once. |
| A checkout is retried after it succeeded | Same order, status 200, nothing changes. |
| A checkout is retried after it failed | It is simply evaluated again. The failed attempt left nothing behind. |
| A cart line is changed while that cart is being checked out | Whichever takes the cart lock first goes first. Either the change is in the order, or the change is refused with `CART_ALREADY_CHECKED_OUT`. A line can never end up in a closed cart without being in its order. |
| Two carts with the same two products check out together | Both lock the product rows in product id order, so they cannot deadlock. With that ordering removed as a test, real deadlocks occurred. |
| Five carts check out with the same coupon at the same moment | Exactly one order gets the discount. The other four get `COUPON_ALREADY_REDEEMED`, their carts stay open and their stock is untouched. |
| A checkout with a valid coupon fails on stock | The coupon is available again and works on the next checkout. |
| Five admins ask for a coupon at the same moment, one milestone owed | Exactly one coupon. The other four get `NO_ELIGIBLE_MILESTONE`. |

Each row of this table has a test in `test/checkout.test.ts` or `test/coupons.test.ts`.

## Decision: The cart itself makes checkout safe to retry

**Context:** A client may retry a checkout because it timed out or never got the response. The retry must not create a second order or take stock twice.

**Options considered:**
- An `Idempotency-Key` header. The client sends a random key with each attempt, and the server stores the key with the response and replays it. This is the general pattern payment APIs use. It needs a table of keys, a rule for the same key arriving with a different body, handling for a request that is still running, and expiry.
- Use the cart. The assignment already says a cart must not be checked out more than once, so `POST /carts/{cartId}/checkout` names exactly one checkout.

**Choice:** The cart. The first successful checkout returns 201. A later checkout of that cart with the same coupon, or with no coupon both times, returns the same order with 200.

A later call with a different coupon is not a retry. It is a second checkout of the same cart. It is refused with `CART_ALREADY_CHECKED_OUT`, the details carry the id of the existing order, and that second coupon is not touched. I chose this over always returning the existing order, because a client that sent a coupon should not get a success response for an order that did not use it.

**Why:** The rule "one order per cart" has to exist anyway, and it already answers the retry question. A separate key would be a second mechanism guarding the same thing.

**Consequences:** It only covers checkout. That is the only call that needs it: setting a cart line and removing one are safe to repeat by design, and creating an empty cart twice does no harm. A general idempotency key is what I would add for other non-repeatable calls in a larger API.

## Decision: Stock is taken at checkout, all or nothing

**Context:** The service must never sell more than it has, also when checkouts overlap. I had to decide when stock is taken and what happens when it runs short.

**Options considered:**
- Hold stock when an item is added to a cart. No surprise at checkout, but abandoned carts would hold stock, so it needs expiry and a cleanup job.
- Take stock at checkout and sell whatever is available. The customer gets an order they did not ask for.
- Take stock at checkout, and fail the whole checkout if any line cannot be supplied in full.

**Choice:** The third. If any line is short, the checkout fails with `INSUFFICIENT_STOCK`. `details.items` lists every short product with the quantity asked for and the quantity left, so the customer can fix the cart in one go and try again.

**Why:** It is the smallest design that can never oversell, and it never gives the customer something different from what they asked for.

**Consequences:** "It was in stock when I added it" can happen. The cart view flags it before checkout, but only if the client looks.

## Decision: Accepting a changed price at checkout

**Context:** This is the second half of "the cart records the price it showed". The cart view tells the customer about a price change. Checkout has to make sure they cannot be charged the new price without having agreed to it.

**Options considered:**
- Charge the current price and say nothing. The response shows what was charged, but only afterwards.
- A flag on checkout. If a price changed and the flag is not set, refuse and report the old and new prices. The client shows them, and calls again with the flag set.
- The client sends the subtotal it expects, and the server refuses if its own subtotal differs.

**Choice:** The flag. Checkout takes `accept_price_changes`, false by default. If a recorded price differs from the current price and the flag is false, checkout fails with `PRICE_CHANGED` and lists each product with both prices. Nothing is written. With the flag true, the order is placed at the current prices.

A client can also accept a new price before checkout by saving that cart line again, which records the current price.

**Why:** It is simple to call and to explain, and by default nobody pays a price they were not shown.

**Consequences, including a known gap:** The flag means "I accept whatever the price is now". It does not say which price the customer saw. If a price changes a second time between the `PRICE_CHANGED` response and the accepting call, the customer pays the newer price without having seen it. The window is a few seconds and needs two price changes on the same product, but it is real. Sending the expected subtotal closes it, at the cost of every checkout call having to carry that number. I chose the simpler call and am naming the gap here.

## Decision: No payment step

**Context:** The assignment allows treating a successful checkout as payment success, or adding a small payment fake, and asks for the choice to be explained.

**Options considered:**
- No payment step. A successful checkout counts as paid.
- A fake payment call inside checkout that tests can make fail.

**Choice:** No payment step.

**Why:** Without a payment, checkout can be one database transaction, and "a failed checkout changes nothing" is simply a rollback. A fake payment inside that transaction would look like it proves more, but it would be modelling something that is not true: a real payment is a network call to another company, and it cannot sit inside a database transaction.

**Consequences:** A real payment changes the shape of checkout. The order would be created as pending, with the stock and any coupon held. The payment would then be attempted outside the transaction, each attempt recorded in its own table so it can be reconciled with the gateway. On success the order is confirmed. On failure or timeout the holds are released. That design also needs an expiry for orders that stay pending. None of that is built here.

## Coupons: what the assignment leaves open, and what I chose

The assignment says some coupon rules are not specified and asks for choices that can be defended. These are mine.

- **Orders are counted across the whole store.** "Every nth successfully placed order" is one count for the store. I considered the other reading, where each customer's own nth order earns that customer a coupon. I did not take it because the assignment has no customers or accounts and says authentication is not needed. Without authentication, "this coupon belongs to customer 7" cannot be enforced, because anyone can claim to be customer 7. If the rule changed to per customer, the design would need a customers table, a customer id on carts, orders and coupons, and the milestone counted per customer.
- **Nothing is generated automatically.** Reaching a milestone makes a coupon owed. The administrator's call creates it. This follows the assignment's wording: "generate a coupon when an unrewarded milestone is eligible". An unrewarded milestone can only exist if reaching one does not create the coupon by itself.
- **One coupon per call, lowest milestone first.** With 12 orders and n = 5, the first call gives the coupon for order 5, the second for order 10, and the third is refused with `NO_ELIGIBLE_MILESTONE` and says the next one is earned at order 15.
- **Whoever holds the code can use it, once.** With no customers, the code itself is the right to the discount. Codes are 10 random characters from an alphabet of 32, about 10^15 possibilities, generated with Node's crypto module.
- **One coupon per order, taken off the whole subtotal.**
- **Every placed order counts toward milestones,** including orders that used a coupon. The milestone count is then simply the number of orders, which the report also shows.
- **Coupons do not expire.** An `expires_at` column is the obvious addition.
- **A coupon that cannot be used fails the checkout.** An unknown code gives `COUPON_NOT_FOUND`, a used one gives `COUPON_ALREADY_REDEEMED`. I did not place the order at full price instead, because the customer expected a discount and would be charged more than they agreed to.
- **The percent lives on the coupon.** It is copied from the setting when the coupon is generated. Changing `x` later does not change coupons that already exist.

**A known weakness.** Because there are no customers, nothing stops one person from collecting every coupon and using them all, one per order. Fixing it needs customer identity and a limit per customer.

## Decision: Redeeming a coupon is one statement

**Context:** A coupon must be used at most once, also when two checkouts send the same code at the same moment.

**Options considered:**
- Read the coupon, check in application code that it is unused, then mark it used. This is the natural way to write it, and it is wrong under concurrency: two requests can both read "unused" before either writes.
- Lock the coupon row first with `SELECT ... FOR UPDATE`, then check and update. Correct, with two statements.
- One `UPDATE` that only matches an unused coupon, and a check of how many rows it changed.

**Choice:** The single `UPDATE`: `SET redeemed_at = now() WHERE code = $1 AND redeemed_at IS NULL`. One row changed means this checkout owns the coupon. No row changed means it was unknown or already used, and a second query tells the client which.

**Why:** The first option has a gap between the check and the write. Two checkouts at the same moment can both read "unused" and both go on to redeem the coupon. Here the database does the check and the change together, so there is no gap. The second option is also correct, but it takes two statements where one is enough.

**Consequences:** It is the same pattern as the stock update, so the two most important guards in the service work the same way.

## Decision: Milestones, and what happens when n changes

**Context:** `n` is a setting, so it can be different after a restart. I had to decide what a milestone is in a way that still makes sense then.

**Options considered:**
- Milestones are multiples of `n` counted from the first order, and the number of coupons owed is recalculated from that. Changing `n` from 5 to 3 after 12 orders would then suddenly owe coupons for orders 3, 6, 9 and 12, long after the fact.
- The next milestone is the last rewarded milestone plus `n`. A change never looks backwards, but the milestones stop being multiples of `n` (13, 16, 19), which is harder to explain to anyone.
- Milestones are always multiples of the current `n`, and the next one is the next multiple above the last milestone that already has a coupon.

**Choice:** The third. Each coupon records the order count that earned it. Example with coupons already given for orders 5 and 10:

- `n` stays 5: the next milestone is 15.
- `n` changes to 3: the next is 12, then 15, then 18.
- `n` changes to 10: the next is 20.

**Why:** It is easy to say: every nth order, counted in multiples of `n`, and never twice for the same ground. A change of `n` only affects milestones that have no coupon yet.

**Consequences:** If milestones were owed but not yet generated when `n` changes, they are measured with the new `n`. A milestone only becomes fixed once its coupon exists. A full history (n was 5 for the first 30 orders, then 3) would need a settings history table. That is not built.

## Decision: Coupon generation uses a lock and a unique constraint

**Context:** Two administrators can ask for a coupon at the same moment. One milestone must not get two coupons.

**Options considered:**
- Only the unique constraint on the milestone. It prevents a duplicate. With the lock removed as a test, six simultaneous calls with two milestones owed never created a duplicate, but the losing calls failed with a 500, and in most runs only one of the two owed coupons was created.
- A lock so that generation calls run one at a time, with the unique constraint behind it.

**Choice:** Both. Generation first takes a PostgreSQL advisory lock, which is a lock on a number, not on a row. I used it because there is no row to lock: the thing being protected is the next milestone, which does not exist yet. The lock is released when the transaction ends.

**Why:** With the lock the outcome is exact. One milestone owed and five callers: one coupon and four clear refusals. Two owed and four callers: two coupons, one per milestone, and two refusals.

**Consequences:** Advisory locks are a PostgreSQL feature. Generation counts orders with `COUNT(*)`, which is fine at this size. A counter row would replace it at scale.

## The report

`GET /admin/report` returns the summary the assignment asks for.

- **Only placed orders count.** A checkout that fails leaves no order behind, and a cart that was never checked out is not an order. So every row in `orders` is a successfully placed order, and the report just counts and sums them.
- **The money figures are sums of what each order stored.** Gross revenue is the sum of order subtotals, total discounts is the sum of order discounts, and net revenue is the sum of order totals. Every order satisfies total = subtotal − discount (the database checks it), so the three sums satisfy net = gross − discounts.
- **Quantity by product comes from order lines.** The name shown next to it is the product's current name.
- **Coupons: generated, available, redeemed.** I read "available" as generated and not yet used, so generated = available + redeemed. The word could also mean "earned but not yet generated". To cover that reading too, the report has a `milestones` block with `coupons_owed` (milestones reached that have no coupon yet), the last rewarded milestone and the next one.

**It reconciles.** A test places a mixed set of orders, some with a coupon, then adds up the orders returned by `GET /orders/{id}` and the coupons returned by `GET /admin/coupons`, and compares the result with the report.

## Decision: The report reads from one snapshot

**Context:** The report is built from three queries: orders, order lines and coupons. Checkouts can commit while it runs. The assignment says the report should reconcile and that repeated requests must not change state.

**Options considered:**
- Run the three queries one after another with no transaction. Each query then sees a different moment. An order can be counted in the number of orders and be missing from the quantities. With the snapshot removed as a test, a test that takes reports while 24 checkouts run failed on every run.
- Put everything into one large SQL statement. One statement sees one moment, but it is hard to read and to change.
- Run the queries in one transaction at the repeatable-read level, marked read only.

**Choice:** The third. Repeatable read means every query in the transaction sees the data as it was when the first one ran. Read only means the database itself refuses a write.

**Why:** The queries stay small and readable, the figures always agree with each other, and "the report does not change state" is enforced by the database, not only by my being careful.

**Consequences:** The report is worked out from all orders on every call. That is fine at this size. With many orders I would keep running totals, or run the report against a read replica. Sums are converted to JavaScript numbers and refused above about 9 × 10^15 paise, far beyond anything this store will reach.

## Admin: changing a product's price or stock

`PATCH /admin/products/{productId}` sets the price, the stock, or both. I added it so the price-change and stock-change behaviour can be exercised through the API, not only with SQL.

- Carts are not touched. They show the change the next time they are viewed, and checkout deals with it.
- Orders never change.
- The stock is set to the number given. A real inventory system would record movements (received 10, sold 1) so that a stock update and a sale at the same moment cannot overwrite each other. Here the last write wins.

## Money and rounding rules

- Every amount is a whole number of paise (100 paise = 1 rupee). That holds in the database (`price_paise integer`), in the code and in the API. `64900` means Rs 649.00.
- There are no floating-point numbers and no decimals anywhere in the money path.
- Price times quantity, and adding lines up, is whole-number arithmetic. It never needs rounding.
- The one place a fraction can appear is a percentage discount. The rule: **discount = subtotal × percent ÷ 100, rounded down to the paisa.** It is worked out once, on the order subtotal. Total = subtotal − discount.
  - Example: 10% of Rs 499.99 is 4999.9 paise. There is no 0.9 of a paisa, so the discount is 4999 paise and the total is Rs 450.00.
  - Rounding down means a discount is never more than the percent says. It can be short by less than one paisa.
  - One discount per order, not one per item. Three bottles at Rs 499.99 give 14999 paise off the order. Rounding the discount on each bottle separately would give 3 × 4999 = 14997, and the pieces would no longer add up to the percentage of the order.
  - The percent is at most 100, so the discount is never more than the subtotal and a total cannot go below zero.
  - The code does not use floating point for this. `discountPaise` in `src/money.ts` multiplies two whole numbers, takes off the remainder, and then divides, so the division is exact.
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

All codes:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The body is not valid JSON, a field has the wrong type or value, the body has a field the service does not know, or an id in the URL is malformed. The details list what was wrong. |
| 404 | `ROUTE_NOT_FOUND` | No such route |
| 404 | `CART_NOT_FOUND` | No cart with that id |
| 404 | `PRODUCT_NOT_FOUND` | No product with that id |
| 404 | `ORDER_NOT_FOUND` | No order with that id |
| 404 | `COUPON_NOT_FOUND` | Checkout with a coupon code that does not exist |
| 409 | `CART_ALREADY_CHECKED_OUT` | A change was sent to a cart that has been checked out, or a checkout names a different coupon than the cart's order used. In the second case `details.order_id` is the existing order. |
| 409 | `COUPON_ALREADY_REDEEMED` | Checkout with a coupon that was used before |
| 409 | `NO_ELIGIBLE_MILESTONE` | Coupon generation when no coupon is owed. The details give `orders_placed` and `next_milestone_at`. |
| 409 | `CART_EMPTY` | Checkout of a cart with no items |
| 409 | `INSUFFICIENT_STOCK` | A quantity is more than is in stock. `details.items` lists each product with `requested` and `available`. |
| 409 | `PRICE_CHANGED` | A price changed since the line was saved and was not accepted. `details.items` lists each product with both prices. |
| 500 | `INTERNAL_ERROR` | Anything unexpected |

**Unknown fields are refused.** A request body with a field the service does not know gets a 400. It is not ignored. The reason is checkout: a misspelt field there would otherwise be dropped silently, and the customer would get an order they did not intend.

**Alternatives considered:**
- RFC 9457 `application/problem+json`. It is a standard, but it has more fields for the same information.
- Adding 422 for business-rule failures. That gives a fourth bucket, and the line between 409 and 422 is hard to state clearly.

## What is implemented and what is deferred

**Implemented**

- Everything in the assignment's minimum list: carts (create, view, set a quantity, remove a line), checkout with an optional coupon, reading an order, coupon generation by the administrator and the administrator's report. Nothing from that list is missing.
- The schema as numbered migrations, and six seed products through a seed script. One product has only 3 in stock.
- Four things beyond the minimum, because the rest could not be exercised properly without them:
  - `GET /products`, so a client can see what can be added to a cart.
  - `GET /admin/coupons`, so an administrator can find a code again after a lost response, and so the report can be checked against something.
  - `PATCH /admin/products/{productId}`, so a price or stock change can be tried through the API and not only with SQL.
  - The `milestones` block in the report.
- API docs as Swagger UI at `/docs`, built from the comments above each route. A test fails if a route and its docs drift apart.
- One command that runs the database and the service in Docker, and one that runs the tests in Docker.

**Deferred on purpose**

| Not built | Why not, and what it would take |
|---|---|
| A payment step | A real payment cannot sit inside a database transaction. It needs pending orders, holds on stock and coupon, a table of payment attempts and an expiry. See "No payment step". |
| Holding stock when an item is added | Abandoned carts would hold stock, so it needs an expiry and a cleanup job. |
| Customers and authentication | The assignment says they are not needed. With them, coupons could belong to a customer and be limited per customer, and `/admin` could be protected. |
| Richer coupons: an expiry date, a fixed amount, a minimum order value, a cap on the discount, more than one use | Not asked for. Each is a column plus a condition in the statement that claims the coupon. More than one use changes that condition from "unused" to "used fewer than the limit", still in one statement. |
| Changing `n` and `x` while the service runs | Needs a settings table with a history, and a rule for a change that races with a checkout. |
| A general `Idempotency-Key` header | Only checkout needs protection against retries, and the cart already gives it. |
| A record of failed checkouts | A failed checkout is a refused request and leaves nothing behind. Keeping a history means writing outside the transaction that is rolled back. It belongs with the payment step. |
| Stock movements in place of a stock number | The admin update sets the stock to a number, and the last write wins. |
| Paging for the coupon list, cleanup of abandoned carts, rate limiting, structured logs, metrics | Needed in production. Not what this assignment tests. |
| Down migrations, or a migration tool | The runner only goes forward. |

## Known weaknesses

Things in what I built that I know are weak. Most are named where they arise. They are collected here.

1. **The price flag accepts whatever the price is now.** If a price changes a second time between the `PRICE_CHANGED` response and the accepting call, the customer pays a price they did not see. The fix is for the client to send the subtotal it saw.
2. **One person can collect every coupon.** There are no customers, so nothing limits who uses the coupons.
3. **No authentication.** Anyone who can reach the service can call `/admin`. A cart is protected only by its id being hard to guess.
4. **No timeouts on the database.** A checkout that waits for a row lock waits as long as the holder takes. Transactions here are a few statements, so the wait is short, but nothing enforces that.
5. **The stock check when a line is saved is a courtesy.** Stock can be gone by checkout. The customer finds out then.
6. **An admin stock update can overwrite a sale.** It sets a number. It does not add or subtract.
7. **Checkouts for the same product queue up.** Each one holds that product's row until its transaction ends. Correct, and fast at this size, but it is a queue.
8. **Coupon generation and the report count all orders on every call.**
9. **The migration runner does not guard against two instances starting at the same moment.**
10. **Carts are never cleaned up.** A lost response to `POST /carts` leaves an empty cart behind for good.
11. **Typing stops at the SQL.** A misspelt column name is found by a test, not by the compiler.
12. **I have only run one instance.** The concurrency tests send overlapping requests through one copy of the service. Each request uses its own database connection, so they do overlap in the database, which is where the guards are. But I have not run two copies side by side.

## Multiple instances and production scale

**Several instances.** Nothing that protects an invariant lives in the memory of the process. The locks are row locks and one advisory lock in PostgreSQL. The checks are conditional updates. The backstops are constraints. Two instances behind a load balancer meet in the database, so they behave like one.

What I would change before running more than one:

- **Migrations become a deploy step.** Today the container applies migrations when it starts. Two instances starting together could both try to apply the same file, and one would fail and restart.
- **Connection pools need sizing.** Each instance opens up to 10 database connections, the driver's default. Many instances need a pooler such as PgBouncer in front of PostgreSQL. The advisory lock is held per transaction, so it works with transaction pooling.
- **Timeouts.** I would set a lock timeout and a statement timeout, and return an error the client can retry.

**More load.**

- **A very popular product.** Checkouts that contain it wait for each other on that product's row. Each wait is one short transaction. For a flash sale I would look at reservations for that product, and accept the extra moving parts then.
- **Counting orders.** With millions of orders I would keep running totals for the report and the milestone count, or run the report on a read replica. I would avoid one counter row that every checkout updates, because every checkout would then wait on the same row.
- **Reads.** The product list and order lookups can go to read replicas. The cart view and checkout stay on the primary, because they need current prices and stock.
- **Money columns** become `bigint`.
- **The database** becomes a managed PostgreSQL with backups and failover. The code does not change for that. It relies on ordinary transactions, row locks and constraints, plus the one advisory lock.
- **Around the service:** authentication, at least for `/admin`. Rate limiting. Structured logs with a request id. Metrics on how checkouts end. Cleanup of old open carts.

## How I used AI

I used Claude, an AI assistant, for the whole assignment. The split was this: **the AI wrote the code, the tests and the first draft of this file. I set the rules, made the design decisions, reviewed each part and corrected it.**

**How the work was organised**

- **Plan before code.** I had the AI go through every open question in the assignment and give me options, a recommendation and the trade-off for each. I accepted some, questioned some and changed some. No code was written until I had approved the plan.
- **One part at a time.** Skeleton, carts, checkout, coupons, report, packaging. Each part came with its tests and its section of this file. I reviewed it and committed it myself. That is why the history is one commit per part.
- **A log.** I had the AI keep a dated log of every point where I changed, rejected or questioned what it proposed. The examples below come from that log.

**How the behaviour was validated**

- The tests run against a real PostgreSQL. The ones that matter send competing or repeated requests.
- For each guard, the AI removed the guard, confirmed that a test failed, and put it back. Where this file says "with the guard removed as a test", it quotes one of those runs. A guard that can be removed without a test failing is not tested.
- The database constraints are a second line. For stock and for coupon generation, the constraint still stopped the bad write when the guard in the code was removed.
- I ran the tests and the Docker setup on my own machine before submitting.

**Where I corrected or redirected the AI**

1. **Milestones when `n` changes.** The AI first said that changing `n` on a store that already has orders was not supported. I asked how the service should adapt, because a setting gets changed one day. Its next proposal was "the last rewarded milestone plus n". With coupons at orders 5 and 10 and a change to n = 3, that gives 13, 16, 19. I rejected it. A rule called "every nth order" should give multiples of n. The rule in the code is mine: the next multiple of the current `n` above the last milestone that has a coupon, which gives 12, 15, 18.
2. **Price changes.** The AI recommended storing no price in the cart and charging the current price at checkout. I did not want a customer to learn about a price change from the bill. I designed what is built: the cart line records the price, checkout takes an acceptance flag that is false by default, and a changed price is refused with both prices. The AI then pointed out the gap in my design (a second change between the two calls) and offered a stricter version. I kept the simpler flag and wrote the gap down.
3. **Migrations and seed data.** The AI proposed a single `schema.sql`. I wanted real migrations and a seeder. The result is numbered migration files with a small runner, and a seed script. I had asked for Prisma. That did not happen, for the reason given in the decision about plain SQL.
4. **Smaller ones.** The currency: the AI proposed US dollars, I changed it to rupees. The API docs: I asked for Swagger UI, and where the AI planned to keep the OpenAPI document in a separate file, I chose to write it as comments above each route. The first version had no `.env.example`, and I asked for one.

**Where the AI changed my mind**

- I thought user accounts were missing, and proposed coupons per customer next to the administrator's coupons. The AI disagreed: the assignment has no accounts, and without authentication a coupon cannot really belong to anyone. I agreed. My reading is recorded as the alternative in the coupon section.
- I proposed a table of checkout attempts, so that failed checkouts are kept as history. The AI argued that this belongs with a payment step. I agreed, and it is in the deferred list.

Most of my corrections were to the design, before the code existed. Once the plan was fixed, the code needed few changes from me.

## Time spent

About 6 hours of my own time:

- about 3 hours on planning: going through the open questions and settling the design before any code was written
- about 2 hours on reviewing each part, running the service and the tests, and correcting
- the rest on reading and correcting this file, and on the final checks

The assignment asks for 4 to 6 hours, so I am at the top of that. The time on the clock was longer: one evening, from about 4 pm to after midnight. The AI built and tested each part while I waited, and I have not counted that waiting time.

## With two more hours

In this order:

1. **Run two instances and attack them from outside.** Start two copies of the service behind a load balancer, and fire the oversell, same-cart and same-coupon cases at them with a load tool. My reasoning that several instances are safe is in this file, but I have only run one.
2. **Close the price gap.** Let checkout take the subtotal the customer saw, and refuse if the service's own subtotal differs. It is a small change, and it removes the first item in the list of known weaknesses.
3. **Timeouts and failure paths.** Set lock and statement timeouts. Test what a client sees when the database goes away in the middle of a checkout. The transaction is rolled back by design, but I have not tested that path.
4. **A cleaner error if the generation lock is ever bypassed.** Today the unique constraint would then answer with a 500. It should be a 409.

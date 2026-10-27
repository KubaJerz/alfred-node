# Walmart

Tested on walmart.com. Walmart blocks after about 15 page loads in one session,
so every step below says what it costs.

## Set the store (2 loads, once)

The store is saved in the browser profile, so this is a one-time step. Kuba's
stores are in `var/USER.md`. Check the store first: the "Pickup or delivery?"
button at the top of any page names it.

    agent-browser open "https://www.walmart.com/store-finder?location=<ZIP>"
    agent-browser snapshot -i | grep "Make this my store"
    agent-browser click @eN      # the button that names the store's address

A Supercenter carries supplements, pharmacy, and general goods. A Neighborhood
Market is mostly grocery, and specialty items are often not there.

## Stock at the store (1 load per product)

Open the product page (`/ip/<name>/<id>`), then read its data:

    agent-browser eval "(()=>{const p=JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.initialData.data.product;return JSON.stringify({name:p.name,seller:p.sellerName,price:p.priceInfo?.currentPrice?.priceString,opts:(p.fulfillmentOptions||[]).map(o=>({type:o.type,status:o.availabilityStatus,where:o.locationText}))})})()"
    agent-browser eval "(document.body.innerText.match(/Aisle [A-Z0-9-]+/)||[''])[0]"

Read `PICKUP` for the store:

| status | meaning |
|---|---|
| `IN_STOCK` | On the shelf now. The aisle is in the page text ("Aisle G7"). |
| `OUT_OF_STOCK` | The store carries it, none on the shelf now. |
| `NOT_AVAILABLE` | The store does not carry this listing. It ships only. |

The seller matters. Only a listing sold by `Walmart.com` is store stock. A
listing sold by the brand or another seller ("Pharmavite LLC",
"eSupplements, llc") ships from them and is almost never on a shelf. The same
product can have both kinds of listing.

## Search (1 load)

    https://www.walmart.com/search?q=<words>

Use search only to find product URLs: `snapshot -i` lists each product as a
link with its name and price. The "In-store" filter is loose. It still shows
"Online only" items and other sellers, so it does not prove stock. Most of the
first results are "Sponsored" ads. Pick the few likely products (sold by
Walmart, a brand stores carry) and check those, within the budget.

## A worked question: "is X at my store?"

1. Check the store at the top of the page (0 loads if a page is already open).
2. Search once (1).
3. Check the 2–4 likeliest products (1 each).
4. Answer with a table: product, price, seller, pickup status, aisle. Name the
   ones you did not check. Send a screenshot of the in-stock one.

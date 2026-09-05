# Saldo Trayvi and Créditos Trayvi

**Status:** APPROVED PRODUCT TERMINOLOGY — financial implementation deferred

## 1. Simple customer model

Trayvi presents two separate concepts:

```text
Saldo Trayvi
RD$ 1,250.00

Créditos Trayvi
RD$ 180.00
```

They are not interchangeable balances.

### Saldo Trayvi

- Denominated in real fiat currency, initially Dominican pesos (`DOP`, displayed as `RD$`).
- May represent provider-custodied available value, refunds, or other legally approved sources.
- Availability, deposit, transfer, and withdrawal behavior will not exist until the custody/regulatory/provider model is approved.

### Créditos Trayvi

- Promotional value funded or authorized by Trayvi.
- May be limited by campaign, market, service, eligibility, maximum use, and expiry.
- Not withdrawable, transferable, or cash-equivalent by default.
- Must include clear restrictions and expiry where applicable.

Trayvi does not use the terms “Trayvi Coin,” cryptocurrency, token, or digital currency for these products.

## 2. UX rules

- Always show Saldo and Créditos separately, even when both can fund one purchase.
- Always show the ISO currency/display symbol and locale-correct formatting.
- Never display a combined “total balance” that implies promotional credit is withdrawable.
- Show `Disponible`, `Pendiente`, and `Retenido` separately when they materially affect an action.
- Explain why an amount is unavailable and when it may change, without revealing fraud controls.
- Show itemized tender before confirmation and in the receipt.
- Do not silently spend credits or select a funding source without the approved product policy and appropriate user notice/control.
- Never expose raw ledger debit/credit language to ordinary users; translate it into clear activity descriptions.
- A pending provider call is “processing,” not “paid,” “refunded,” or “withdrawn.”
- Error/retry copy must not encourage a duplicate payment or payout request.

## 3. Mixed-payment example

For a DOP 200 trip where the customer has DOP 150 of eligible promotional credit and chooses an approved DOP 50 fiat source:

```text
Trip total                 RD$ 200.00
Créditos Trayvi          − RD$ 150.00
Saldo/payment method     − RD$  50.00
Amount remaining           RD$   0.00
```

The receipt must distinguish promotional subsidy from customer money. The driver's contractual earning is not accidentally reduced to the customer's out-of-pocket amount.

This is illustrative. Tender ordering, opt-in, maximum use, refunds, expiry, and cancellation behavior require an approved product/financial plan.

## 4. Driver financial view

```text
Ganancias de hoy
RD$ 1,350.00

Disponible
RD$ 4,820.00

Pendiente
RD$ 740.00
```

If relevant, the driver also sees retained amounts and cash obligations to Trayvi. The UI must explain that:

- earnings are economic activity, not automatically withdrawable cash;
- available funds have passed applicable settlement/hold/liability rules;
- pending funds are not yet available;
- cash collected from customers may create an amount owed to Trayvi;
- a submitted payout is not settled until confirmed/reconciled.

Every figure includes currency, an `asOf` time, and a navigable itemized activity history.

## 5. Cash example

```text
Customer paid in cash       RD$ 120.00
Your earning                RD$ 100.00
Trayvi fee owed             RD$  20.00
New digital payout          RD$   0.00
```

The receipt prevents the interpretation that Trayvi owes the driver another RD$100 digitally. Later offset or collection is shown as a separate item with source, amount, date, and resulting available position.

## 6. Promotional disclosures

A credit view should expose, where applicable:

- original value and remaining value;
- campaign/source in user-friendly language;
- eligible services/markets;
- maximum redemption or minimum fare;
- expiration date/time in the market time zone;
- non-withdrawable/nontransferable status;
- cancellation/refund behavior;
- link to material terms.

Expired/revoked credit disappears from available but remains in activity history where policy and retention permit.

## 7. Security-sensitive interactions

Payout destination changes, high-risk recovery, refunds, withdrawals, unusual payment-method changes, and privileged adjustments may require recent authentication, step-up verification, cooling-off, notification, or review. The UI must present truthful processing/hold states without exposing internal risk scores or enabling enumeration.

There is no generic employee-facing “Edit balance” feature. Authorized corrections are explicit adjustments or reversals with reason, evidence, approval, and audit.

## 8. Accessibility and localization

- Do not rely on red/green or sign alone; use labels such as “Crédito,” “Cargo,” “Pendiente,” and “Revertido.”
- Screen-reader labels pronounce amount and currency unambiguously.
- Negative signs, parentheses, decimal/group separators, and `RD$` placement follow tested locale formatting.
- Large text does not truncate the amount, currency, state, or primary action.
- Sensitive amounts can be hidden/revealed without removing their accessible label/state.

## 9. Out of scope now

No balance screen, wallet, deposit, payment method, card, withdrawal, payout, transfer, cryptocurrency, or real provider integration is authorized by this document. The [Financial Architecture](../architecture/FINANCIAL_ARCHITECTURE.md) and Phase 12A must be completed and audited first.

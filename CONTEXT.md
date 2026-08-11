# Investment Sync

This context covers the investment performance information transferred from Fintual into Actual Budget.

## Language

**Goal Performance Data**:
Validated valuation and cost-basis observations for a Fintual goal over a requested time interval. The sync uses two datasets with different time intervals to calculate recent balance and deposit changes.
_Avoid_: Raw GraphQL response, performance payload

**Reference Goal Performance Data**:
Goal Performance Data that supplies the observation immediately before the recent calculation period. Its Fintual time interval is an implementation detail.
_Avoid_: Six-month data, baseline data

**Recent Goal Performance Data**:
Goal Performance Data that supplies the observations used to calculate recent balance and deposit changes. Its Fintual time interval is an implementation detail.
_Avoid_: Last-month data, current data

**Performance Snapshot**:
The typed balance and deposit observations passed from the Fintual sync step to the Actual sync step. One module owns its shape and persistence; the JSON file is a write-only implementation detail kept for inspection.
_Avoid_: Balance file, balance-2.json, performance payload

### Sign-in

**Email 2FA Code**:
The six-digit code Fintual sends by email to complete sign-in when the account has two-factor authentication enabled.
_Avoid_: OTP, verification code, security code

### Synchronization

**Variation Transaction**:
A balance-change transaction for one date, identified by the `fintual-variation:<date>` imported id, managed as a unit by the Actual sync.
_Avoid_: Balance transaction, sync entry

**Reconciliation Plan**:
The create, update, and delete actions plus warnings derived from comparing balance entries against existing Variation Transactions.
_Avoid_: Diff, action list

**Synchronization Attempt**:
One download → plan → mutate → sync unit, retryable as a whole because each attempt re-derives its plan from freshly downloaded state.
_Avoid_: Retry, run

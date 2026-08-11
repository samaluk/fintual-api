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

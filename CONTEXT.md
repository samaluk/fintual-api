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

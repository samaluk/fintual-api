import { Schema } from "effect"

import { getErrorMessage } from "../logging.ts"

export class ActualDataDirectoryFailure extends Schema.TaggedError<ActualDataDirectoryFailure>()(
  "ActualDataDirectoryFailure",
  {
    path: Schema.optional(Schema.String),
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to reset Actual data directory: ${getErrorMessage(this.cause)}`
  }
}

export class ActualHealthCheckFailure extends Schema.TaggedError<ActualHealthCheckFailure>()(
  "ActualHealthCheckFailure",
  {
    url: Schema.String,
    status: Schema.optional(Schema.Finite),
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Actual server is unreachable at ${this.url}: ${getErrorMessage(this.cause)}`
  }
}

export class ActualInitializationFailure extends Schema.TaggedError<ActualInitializationFailure>()(
  "ActualInitializationFailure",
  {
    serverUrl: Schema.optional(Schema.String),
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to initialize Actual API: ${getErrorMessage(this.cause)}`
  }
}

export class ActualInvalidStartingDate extends Schema.TaggedError<ActualInvalidStartingDate>()(
  "ActualInvalidStartingDate",
  {
    startingDate: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Actual starting date is invalid: ${this.startingDate}`
  }
}

export class ActualOperationFailure extends Schema.TaggedError<ActualOperationFailure>()(
  "ActualOperationFailure",
  {
    operation: Schema.Literals([
      "download_budget",
      "get_transactions",
      "get_payees",
      "create_transaction",
      "update_transaction",
      "delete_transaction",
      "sync",
      "shutdown",
    ]),
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Actual ${this.operation} failed: ${getErrorMessage(this.cause)}`
  }
}

export type ActualError =
  | ActualDataDirectoryFailure
  | ActualHealthCheckFailure
  | ActualInitializationFailure
  | ActualInvalidStartingDate
  | ActualOperationFailure

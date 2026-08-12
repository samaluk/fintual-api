import { Schema } from "effect"
import { getErrorMessage } from "../log.ts"

export class ActualDataDirectoryFailure extends Schema.TaggedError<ActualDataDirectoryFailure>()(
  "ActualDataDirectoryFailure",
  {
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
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to initialize Actual API: ${getErrorMessage(this.cause)}`
  }
}

export class ActualBudgetDownloadFailure extends Schema.TaggedError<ActualBudgetDownloadFailure>()(
  "ActualBudgetDownloadFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to download Actual budget: ${getErrorMessage(this.cause)}`
  }
}

export class ActualTransactionsReadFailure extends Schema.TaggedError<ActualTransactionsReadFailure>()(
  "ActualTransactionsReadFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to fetch Actual transactions: ${getErrorMessage(this.cause)}`
  }
}

export class ActualPayeesReadFailure extends Schema.TaggedError<ActualPayeesReadFailure>()(
  "ActualPayeesReadFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to fetch Actual payees: ${getErrorMessage(this.cause)}`
  }
}

export class ActualTransactionCreationFailure extends Schema.TaggedError<ActualTransactionCreationFailure>()(
  "ActualTransactionCreationFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to add Actual transaction: ${getErrorMessage(this.cause)}`
  }
}

export class ActualTransactionUpdateFailure extends Schema.TaggedError<ActualTransactionUpdateFailure>()(
  "ActualTransactionUpdateFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to update Actual transaction: ${getErrorMessage(this.cause)}`
  }
}

export class ActualDuplicateDeletionFailure extends Schema.TaggedError<ActualDuplicateDeletionFailure>()(
  "ActualDuplicateDeletionFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to delete duplicate Actual transaction: ${getErrorMessage(this.cause)}`
  }
}

export class ActualSyncFailure extends Schema.TaggedError<ActualSyncFailure>()(
  "ActualSyncFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to sync Actual budget: ${getErrorMessage(this.cause)}`
  }
}

export class ActualShutdownFailure extends Schema.TaggedError<ActualShutdownFailure>()(
  "ActualShutdownFailure",
  {
    cause: Schema.Defect(),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Failed to shutdown Actual API: ${getErrorMessage(this.cause)}`
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

export type ActualError =
  | ActualDataDirectoryFailure
  | ActualHealthCheckFailure
  | ActualInitializationFailure
  | ActualBudgetDownloadFailure
  | ActualTransactionsReadFailure
  | ActualPayeesReadFailure
  | ActualTransactionCreationFailure
  | ActualTransactionUpdateFailure
  | ActualDuplicateDeletionFailure
  | ActualSyncFailure
  | ActualInvalidStartingDate

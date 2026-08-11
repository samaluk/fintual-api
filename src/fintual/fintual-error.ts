import { Schema } from "effect"
import { getErrorMessage } from "../log.ts"

export class UnexpectedHttpStatus extends Schema.TaggedError<UnexpectedHttpStatus>()(
  "UnexpectedHttpStatus",
  {
    stage: Schema.String,
    status: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.stage}: unexpected HTTP status ${this.status}`
  }
}

export class HttpTransportFailure extends Schema.TaggedError<HttpTransportFailure>()(
  "HttpTransportFailure",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  status: Schema.Number,
}) {
  override get message(): string {
    return `Fintual login: unexpected HTTP status ${this.status}`
  }
}

export class MalformedGoalPerformanceData extends Schema.TaggedError<MalformedGoalPerformanceData>()(
  "MalformedGoalPerformanceData",
  {
    purpose: Schema.Literals(["reference", "recent"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Fintual ${this.purpose} Goal Performance Data: validation failed`
  }
}

export class MalformedPerformanceSnapshot extends Schema.TaggedError<MalformedPerformanceSnapshot>()(
  "MalformedPerformanceSnapshot",
  {
    issues: Schema.String,
  },
) {
  override get message(): string {
    return `Fintual performance snapshot is invalid: ${this.issues}`
  }
}

export class Email2FAFailure extends Schema.TaggedError<Email2FAFailure>()("Email2FAFailure", {
  stage: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class SnapshotWriteFailure extends Schema.TaggedError<SnapshotWriteFailure>()(
  "SnapshotWriteFailure",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export type FintualError =
  | UnexpectedHttpStatus
  | HttpTransportFailure
  | LoginFailed
  | MalformedGoalPerformanceData
  | MalformedPerformanceSnapshot
  | Email2FAFailure
  | SnapshotWriteFailure

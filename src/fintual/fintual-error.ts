import { Schema } from "effect"

import { getErrorMessage } from "../logging.ts"

export class UnexpectedHttpStatus extends Schema.TaggedError<
  UnexpectedHttpStatus,
  { readonly brand: unique symbol }
>()("UnexpectedHttpStatus", {
  stage: Schema.String,
  status: Schema.Finite,
}) {
  override get message(): string {
    return `${this.stage}: unexpected HTTP status ${this.status}`
  }
}

export class HttpTransportFailure extends Schema.TaggedError<
  HttpTransportFailure,
  { readonly brand: unique symbol }
>()("HttpTransportFailure", {
  stage: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class LoginFailed extends Schema.TaggedError<
  LoginFailed,
  { readonly brand: unique symbol }
>()("LoginFailed", {
  status: Schema.Finite,
}) {
  override get message(): string {
    return `Fintual login: unexpected HTTP status ${this.status}`
  }
}

export class MalformedGoalPerformanceData extends Schema.TaggedError<
  MalformedGoalPerformanceData,
  { readonly brand: unique symbol }
>()("MalformedGoalPerformanceData", {
  purpose: Schema.Literals(["reference", "recent"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Fintual ${this.purpose} Goal Performance Data: validation failed`
  }
}

export class MalformedPerformanceSnapshot extends Schema.TaggedError<
  MalformedPerformanceSnapshot,
  { readonly brand: unique symbol }
>()("MalformedPerformanceSnapshot", {
  issues: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Fintual performance snapshot is invalid: ${this.issues}`
  }
}

export class Email2FAFailure extends Schema.TaggedError<
  Email2FAFailure,
  { readonly brand: unique symbol }
>()("Email2FAFailure", {
  stage: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return getErrorMessage(this.cause)
  }
}

export class SnapshotWriteFailure extends Schema.TaggedError<
  SnapshotWriteFailure,
  { readonly brand: unique symbol }
>()("SnapshotWriteFailure", {
  cause: Schema.Defect(),
}) {
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

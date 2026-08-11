# Typed failures at domain seams

The old `src/effect.ts` aliases wrap third-party rejections in a plain `Error`, erasing domain distinctions and forcing consumers such as the Actual retry classifier to inspect message text. Delete the generic aliases and model expected failures at each domain seam as `Schema.TaggedErrorClass` values. Preserve the existing message wording, keep the original failure in `cause`, and compute retryability or other control-flow classification where the third-party failure is first visible. Consumers use `catchTag` or `catchIf`; they do not classify failures by message text.

Per-seam implementations are owned by the domain issues: Actual by #286, Fintual HTTP and the snapshot artifact by #283, and IMAP by #284. This ADR records the shared convention used by those implementations and by #285 when it removes the aliases.

## Status

accepted

## Considered Options

- **One shared tagged error with a source field** — rejected because it centralizes unrelated failures and weakens domain-specific recovery.
- **Plain `Error` values with message classification** — rejected because message wording becomes a hidden control-flow API; it also leaves the record-shaped `PostError` retry branch unreachable after the aliases wrap the original failure.

## Consequences

- Public domain seams expose discoverable failure unions instead of generic errors.
- Existing human-readable error messages remain stable while control flow depends on tags and fields.
- Each domain issue owns its error taxonomy and third-party failure mapping; this convention does not add configuration work outside those issue scopes.

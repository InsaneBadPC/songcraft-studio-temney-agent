export type DocumentStatus = "draft" | "complete" | "archived";

const DOCUMENT_STATUSES: readonly DocumentStatus[] = ["draft", "complete", "archived"];

export function normalizeDocumentStatus(value: unknown): DocumentStatus {
  return DOCUMENT_STATUSES.find((status) => status === value) ?? "draft";
}

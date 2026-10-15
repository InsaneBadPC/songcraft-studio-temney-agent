import { supabase } from "@/lib/supabase";

/**
 * Klient servisní konzole.
 *
 * Všechno jde přes edge funkci `songcraft-service-console`, která sama ověřuje
 * JWT a to, že účet je v tabulce `sc_service_accounts`. Klient tady jen posílá
 * akce - žádná data uživatele nečte přímo z databáze, protože k nim nemá
 * oprávnění a RLS by je stejně odmítlo.
 *
 * Operace, které něco mění, mají vždy dva kroky: prepare_* vrátí
 * `confirmationToken` a změnu provede až `confirm_*` s ním. Samotné ID úlohy
 * potvrzením není.
 */

export type ServiceUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  isService: boolean;
  serviceLabel: string | null;
  rows: Record<string, number>;
  totalRows: number;
  files: number;
};

export type ServiceJob = {
  id: string;
  kind: "backup" | "restore";
  mode: "full" | "restore_existing" | "restore_new";
  status: "queued" | "awaiting_confirmation" | "running" | "done" | "failed" | "canceled";
  target_user_id: string | null;
  source_backup_id: string | null;
  archive_path: string | null;
  archive_bytes: number | null;
  manifest: Record<string, unknown>;
  progress: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  downloadUrl?: string | null;
};

export type ServiceWarning = string[];

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("songcraft-service-console", { body });
  if (error) throw new Error(error.message ?? "Servisní konzole neodpověděla.");
  const payload = data as { error?: string } & T;
  if (payload?.error) throw new Error(payload.error);
  return payload;
}

export function listServiceUsers() {
  return call<{ users: ServiceUser[]; tables: string[]; neverExported: string[] }>({ action: "list_users" });
}

export function createServiceUser(input: { email: string; password: string; displayName: string }) {
  return call<{ userId: string | null; message: string; warnings: ServiceWarning }>({ action: "create_user", ...input });
}

export function startServiceBackup() {
  return call<{ job: ServiceJob; message: string }>({ action: "start_backup" });
}

export function prepareServiceRestore(input: {
  sourceBackupId: string;
  targetUserId?: string;
  mode: "restore_existing" | "restore_new";
  email?: string;
  password?: string;
  displayName?: string;
}) {
  return call<{ job: ServiceJob; confirmationToken: string; message: string; warnings: ServiceWarning }>({ action: "prepare_restore", ...input });
}

export function confirmServiceRestore(jobId: string, confirmationToken: string) {
  return call<{ job: ServiceJob; message: string }>({ action: "confirm_restore", jobId, confirmationToken });
}

export function listServiceJobs(jobId?: string) {
  return call<{ jobs: ServiceJob[] }>({ action: "job_status", ...(jobId ? { jobId } : {}) });
}

export function cancelServiceJob(jobId: string) {
  return call<{ ok: boolean; message: string }>({ action: "cancel_job", jobId });
}

/** Hotové zálohy, ze kterých lze obnovit. */
export function completedBackups(jobs: ServiceJob[]) {
  return jobs.filter((job) => job.kind === "backup" && job.status === "done");
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes < 0) return "—";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
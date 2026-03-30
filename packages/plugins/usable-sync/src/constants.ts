export const PLUGIN_ID = "usable-sync";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  reconcile: "usable-reconcile",
} as const;

export const WEBHOOK_KEYS = {
  usable: "usable-ingest",
} as const;

export const DEFAULT_CONFIG = {
  usableWorkspaceId: "",
  usablePatSecretRef: "",
  taskFragmentTypeId: "",
  configFragmentTypeId: "",
  configWorkspaceId: "",
  instanceTag: "default",
  companyFilter: "",
  syncIntervalSeconds: 300,
  webhookSecretRef: "",
  enabled: false,
} as const;

export type UsableSyncConfig = {
  usableWorkspaceId: string;
  usablePatSecretRef: string;
  /** Fragment type for synced tasks (e.g. "Task" type) */
  taskFragmentTypeId: string;
  /** Fragment type for company config fragments (org chart, agents, settings) */
  configFragmentTypeId: string;
  /** Workspace for config fragments. Falls back to usableWorkspaceId if empty. */
  configWorkspaceId: string;
  instanceTag: string;
  /** Comma-separated issue prefixes (e.g. "USA,ENG") to limit sync. Empty = sync all companies. */
  companyFilter: string;
  syncIntervalSeconds: number;
  webhookSecretRef: string;
  enabled: boolean;
};

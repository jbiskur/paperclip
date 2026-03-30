import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Usable Sync",
  description:
    "Bidirectional task sync between Paperclip issues and Usable memory fragments. Syncs to the Usable Tasks workspace so tasks are visible in Mission Control.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "agents.read",
    "goals.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "metrics.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable Sync",
        description: "Master toggle for the bidirectional sync.",
        default: DEFAULT_CONFIG.enabled,
      },
      usableWorkspaceId: {
        type: "string",
        title: "Usable Workspace ID",
        description: "UUID of the Usable Tasks workspace to sync with.",
        default: DEFAULT_CONFIG.usableWorkspaceId,
      },
      usablePatSecretRef: {
        type: "string",
        title: "Usable PAT (Secret Reference)",
        description:
          "Secret reference to a Usable Personal Access Token (PAT). Create the secret first, then enter its reference here.",
        default: DEFAULT_CONFIG.usablePatSecretRef,
      },
      taskFragmentTypeId: {
        type: "string",
        title: "Task Fragment Type ID",
        description: "UUID of the Usable fragment type for synced tasks (e.g. the 'Task' type).",
        default: DEFAULT_CONFIG.taskFragmentTypeId,
      },
      configFragmentTypeId: {
        type: "string",
        title: "Config Fragment Type ID",
        description:
          "UUID of the Usable fragment type for company configuration (org chart, agents, settings). Used for visualization in Mission Control.",
        default: DEFAULT_CONFIG.configFragmentTypeId,
      },
      configWorkspaceId: {
        type: "string",
        title: "Config Workspace ID (optional)",
        description:
          "UUID of a separate Usable workspace for config fragments (org chart, etc.). Leave empty to use the same workspace as tasks.",
        default: DEFAULT_CONFIG.configWorkspaceId,
      },
      instanceTag: {
        type: "string",
        title: "Instance Tag",
        description:
          "Unique identifier for this Paperclip instance. Used as 'paperclip:<tag>' to scope synced fragments. Multiple instances can share one workspace.",
        default: DEFAULT_CONFIG.instanceTag,
      },
      companyFilter: {
        type: "string",
        title: "Company Filter (Issue Prefixes)",
        description:
          "Comma-separated issue prefixes to limit which companies sync (e.g. 'USA,ENG'). Leave empty to sync all companies.",
        default: DEFAULT_CONFIG.companyFilter,
      },
      syncIntervalSeconds: {
        type: "number",
        title: "Reconciliation Interval (seconds)",
        description: "How often to run the reconciliation job that catches missed webhooks. Default: 300 (5 minutes).",
        default: DEFAULT_CONFIG.syncIntervalSeconds,
      },
      webhookSecretRef: {
        type: "string",
        title: "Webhook Secret (Secret Reference)",
        description: "Secret reference for authenticating incoming Usable webhooks.",
        default: DEFAULT_CONFIG.webhookSecretRef,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.reconcile,
      displayName: "Usable Reconciliation",
      description: "Polls Usable for fragments updated since last sync to catch missed webhooks.",
      schedule: "*/5 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.usable,
      displayName: "Usable Fragment Events",
      description: "Receives fragment.created, fragment.updated, and fragment.deleted events from Usable.",
    },
  ],
};

export default manifest;

/**
 * Bidirectional mapping between Paperclip issue fields and Usable fragment fields.
 */

// --- Status mapping ---

const PAPERCLIP_TO_USABLE_STATUS: Record<string, string> = {
  backlog: "todo",
  todo: "todo",
  in_progress: "in-progress",
  in_review: "in-progress",
  done: "done",
  blocked: "todo",
  cancelled: "archived",
};

const USABLE_TO_PAPERCLIP_STATUS: Record<string, string> = {
  todo: "todo",
  "in-progress": "in_progress",
  done: "done",
  archived: "cancelled",
};

export function toPaperclipStatus(usableStatus: string): string {
  return USABLE_TO_PAPERCLIP_STATUS[usableStatus] ?? "backlog";
}

export function toUsableStatus(paperclipStatus: string): string {
  return PAPERCLIP_TO_USABLE_STATUS[paperclipStatus] ?? "todo";
}

// --- Priority mapping ---

const PAPERCLIP_TO_USABLE_PRIORITY: Record<string, string> = {
  critical: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
};

const USABLE_TO_PAPERCLIP_PRIORITY: Record<string, string> = {
  urgent: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

export function toPaperclipPriority(usablePriority: string): string {
  return USABLE_TO_PAPERCLIP_PRIORITY[usablePriority] ?? "medium";
}

export function toUsablePriority(paperclipPriority: string): string {
  return PAPERCLIP_TO_USABLE_PRIORITY[paperclipPriority] ?? "medium";
}

// --- Tag building ---

export function buildFragmentTags(opts: {
  instanceTag: string;
  status: string;
  priority: string;
  projectName?: string;
  isBlocked?: boolean;
  extra?: string[];
}): string[] {
  const tags: string[] = [
    "task",
    "paperclip",
    `paperclip:${opts.instanceTag}`,
    `status:${opts.status}`,
    `priority:${opts.priority}`,
    "source:paperclip",
  ];
  if (opts.projectName) {
    tags.push(`project:${opts.projectName}`);
  }
  if (opts.isBlocked) {
    tags.push("blocked");
  }
  if (opts.extra) {
    tags.push(...opts.extra);
  }
  return tags;
}

// --- Fragment key ---

export function issueFragmentKey(identifier: string): string {
  return `issue-${identifier}`.toLowerCase();
}

// --- Frontmatter serialization (MC-compatible YAML) ---

export function buildFrontmatter(opts: {
  status: string;
  priority: string;
  assigneeId?: string | null;
  createdAt: string;
  startDate?: string | null;
  endDate?: string | null;
  dependencies?: string[];
  kanbanOrder?: number;
  listOrder?: number;
}): string {
  const lines: string[] = ["---"];
  lines.push(`status: "${opts.status}"`);
  lines.push(`priority: "${opts.priority}"`);
  if (opts.assigneeId) {
    lines.push(`assigneeId: "${opts.assigneeId}"`);
  }
  lines.push(`kanbanOrder: ${opts.kanbanOrder ?? 0}`);
  lines.push(`listOrder: ${opts.listOrder ?? 0}`);
  lines.push(`createdAt: "${opts.createdAt}"`);
  lines.push(`startDate: ${opts.startDate ? `"${opts.startDate}"` : "null"}`);
  lines.push(`endDate: ${opts.endDate ? `"${opts.endDate}"` : "null"}`);
  if (opts.dependencies && opts.dependencies.length > 0) {
    lines.push(`dependencies:`);
    for (const dep of opts.dependencies) {
      lines.push(`  - "${dep}"`);
    }
  } else {
    lines.push(`dependencies: []`);
  }
  lines.push("---");
  return lines.join("\n");
}

// --- Fragment content builder ---

export function buildFragmentContent(opts: {
  frontmatter: string;
  description?: string | null;
  comments?: Array<{ author: string; body: string; createdAt: string }>;
}): string {
  const sections: string[] = [opts.frontmatter, ""];

  if (opts.description) {
    sections.push("## Description");
    sections.push(opts.description);
    sections.push("");
  }

  if (opts.comments && opts.comments.length > 0) {
    sections.push("## Comments");
    for (const comment of opts.comments) {
      sections.push(`**${comment.author}** (${comment.createdAt}):`);
      sections.push(comment.body);
      sections.push("");
    }
  }

  return sections.join("\n");
}

// --- Metadata builder ---

export interface SyncMetadata {
  paperclipIssueId: string;
  paperclipIdentifier: string;
  paperclipInstance: string;
  companyId: string;
  assigneeAgentId?: string | null;
  parentIdentifier?: string | null;
  checkoutRunId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastSyncSource: "paperclip" | "usable";
  lastSyncedAt: string;
}

export function buildMetadata(opts: {
  issueId: string;
  identifier: string;
  instanceTag: string;
  companyId: string;
  assigneeAgentId?: string | null;
  parentIdentifier?: string | null;
  checkoutRunId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}): SyncMetadata {
  return {
    paperclipIssueId: opts.issueId,
    paperclipIdentifier: opts.identifier,
    paperclipInstance: opts.instanceTag,
    companyId: opts.companyId,
    assigneeAgentId: opts.assigneeAgentId ?? null,
    parentIdentifier: opts.parentIdentifier ?? null,
    checkoutRunId: opts.checkoutRunId ?? null,
    startedAt: opts.startedAt ?? null,
    completedAt: opts.completedAt ?? null,
    lastSyncSource: "paperclip",
    lastSyncedAt: new Date().toISOString(),
  };
}

// --- Parse frontmatter from fragment content ---

export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s+-\s+"?([^"]*)"?$/);
    if (arrayItemMatch && currentKey && currentArray) {
      currentArray.push(arrayItemMatch[1]);
      continue;
    }

    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (value === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }
    if (value === "[]") {
      result[key] = [];
    } else if (value === "null") {
      result[key] = null;
    } else if (value.startsWith('"') && value.endsWith('"')) {
      result[key] = value.slice(1, -1);
    } else if (!isNaN(Number(value))) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }

  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

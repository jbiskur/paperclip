import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import { DEFAULT_CONFIG, JOB_KEYS, WEBHOOK_KEYS, type UsableSyncConfig } from "./constants.js";
import {
  buildFragmentContent,
  buildFragmentTags,
  buildFrontmatter,
  buildMetadata,
  issueFragmentKey,
  parseFrontmatter,
  toPaperclipPriority,
  toPaperclipStatus,
  toUsablePriority,
  toUsableStatus,
  type SyncMetadata,
} from "./mapping.js";
import { UsableClient } from "./usable-client.js";

let currentContext: PluginContext | null = null;
let usableClient: UsableClient | null = null;
/** Cached map of companyId -> issuePrefix for allowed companies. Null = sync all. */
let companyAllowMap: Map<string, string> | null = null;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<UsableSyncConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as UsableSyncConfig) };
}

async function getUsableClient(ctx: PluginContext): Promise<UsableClient | null> {
  if (usableClient) return usableClient;

  const config = await getConfig(ctx);
  if (!config.usablePatSecretRef) return null;

  try {
    const pat = await ctx.secrets.resolve(config.usablePatSecretRef);
    if (!pat) return null;

    const httpFetch = ctx.http.fetch.bind(ctx.http);
    usableClient = new UsableClient(pat, httpFetch as unknown as typeof fetch);
    return usableClient;
  } catch {
    return null;
  }
}

function isConfigured(config: UsableSyncConfig): boolean {
  return config.enabled && !!config.usableWorkspaceId && !!config.usablePatSecretRef;
}

// ---------------------------------------------------------------------------
// Company filter helpers
// ---------------------------------------------------------------------------

async function resolveCompanyFilter(ctx: PluginContext): Promise<Map<string, string> | null> {
  if (companyAllowMap) return companyAllowMap;

  const config = await getConfig(ctx);
  const filter = config.companyFilter.trim();
  if (!filter) return null; // sync all

  const prefixes = filter.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (prefixes.length === 0) return null;

  const companies = await ctx.companies.list();
  const map = new Map<string, string>();
  for (const company of companies) {
    const prefix = (company as { issuePrefix?: string }).issuePrefix?.toUpperCase();
    if (prefix && prefixes.includes(prefix)) {
      map.set(company.id, prefix);
    }
  }

  if (map.size === 0) {
    ctx.logger.warn(`Company filter "${filter}" matched no companies`);
  } else {
    ctx.logger.info(`Company filter resolved: ${[...map.values()].join(", ")}`);
  }

  companyAllowMap = map;
  return map;
}

async function isCompanyAllowed(ctx: PluginContext, companyId: string): Promise<boolean> {
  const map = await resolveCompanyFilter(ctx);
  if (!map) return true; // no filter = all allowed
  return map.has(companyId);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getLastSyncTime(ctx: PluginContext): Promise<string | null> {
  return (await ctx.state.get({ scopeKind: "instance", stateKey: "lastSyncTime" })) as string | null;
}

async function setLastSyncTime(ctx: PluginContext, time: string): Promise<void> {
  await ctx.state.set({ scopeKind: "instance", stateKey: "lastSyncTime" }, time);
}

async function getFragmentIdMapping(
  ctx: PluginContext,
  issueId: string,
): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `fragment-map:${issueId}`,
  })) as string | null;
}

async function setFragmentIdMapping(
  ctx: PluginContext,
  issueId: string,
  fragmentId: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `fragment-map:${issueId}` },
    fragmentId,
  );
}

// ---------------------------------------------------------------------------
// Paperclip -> Usable sync
// ---------------------------------------------------------------------------

async function syncIssueToUsable(ctx: PluginContext, issue: Issue): Promise<void> {
  const config = await getConfig(ctx);
  if (!isConfigured(config)) return;
  if (!(await isCompanyAllowed(ctx, issue.companyId))) return;

  const client = await getUsableClient(ctx);
  if (!client) return;

  const usableStatus = toUsableStatus(issue.status);
  const usablePriority = toUsablePriority(issue.priority ?? "medium");

  const tags = buildFragmentTags({
    instanceTag: config.instanceTag,
    status: usableStatus,
    priority: usablePriority,
    isBlocked: issue.status === "blocked",
  });

  const frontmatter = buildFrontmatter({
    status: usableStatus,
    priority: usablePriority,
    assigneeId: issue.assigneeAgentId,
    createdAt: issue.createdAt.toISOString(),
    startDate: issue.startedAt ? issue.startedAt.toISOString().split("T")[0] : null,
    endDate: issue.completedAt ? issue.completedAt.toISOString().split("T")[0] : null,
  });

  const content = buildFragmentContent({
    frontmatter,
    description: issue.description,
  });

  const metadata = buildMetadata({
    issueId: issue.id,
    identifier: issue.identifier ?? issue.id,
    instanceTag: config.instanceTag,
    companyId: issue.companyId,
    assigneeAgentId: issue.assigneeAgentId,
    startedAt: issue.startedAt?.toISOString() ?? null,
    completedAt: issue.completedAt?.toISOString() ?? null,
  });

  const key = issueFragmentKey(issue.identifier ?? issue.id);

  const existingFragmentId = await getFragmentIdMapping(ctx, issue.id);

  const fragmentData = {
    title: `${issue.identifier ?? issue.id}: ${issue.title}`,
    content,
    tags,
    metadata: metadata as unknown as Record<string, unknown>,
  };

  // Try cached mapping first, then key lookup, then create
  let resolved = false;

  if (existingFragmentId) {
    try {
      await client.updateFragment(existingFragmentId, fragmentData);
      ctx.logger.info(`Updated Usable fragment ${existingFragmentId} for ${issue.identifier}`);
      resolved = true;
    } catch {
      // Fragment may have been deleted — clear stale mapping and fall through
      await setFragmentIdMapping(ctx, issue.id, "");
    }
  }

  if (!resolved) {
    const existing = await client.getFragmentByKey(key, config.usableWorkspaceId);
    if (existing) {
      try {
        await client.updateFragment(existing.id, fragmentData);
        await setFragmentIdMapping(ctx, issue.id, existing.id);
        ctx.logger.info(`Linked existing fragment ${existing.id} to ${issue.identifier}`);
        resolved = true;
      } catch {
        // Fragment lookup succeeded but update failed — fall through to create
      }
    }
  }

  if (!resolved) {
    try {
      const result = await client.createFragment({
        workspaceId: config.usableWorkspaceId,
        fragmentTypeId: config.taskFragmentTypeId,
        ...fragmentData,
        key,
      });
      await setFragmentIdMapping(ctx, issue.id, result.fragmentId);
      ctx.logger.info(`Created Usable fragment ${result.fragmentId} for ${issue.identifier}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("409") || errMsg.includes("Duplicate")) {
        // Key exists but lookup failed — search by tag
        const results = await client.listFragments({
          workspaceId: config.usableWorkspaceId,
          query: `tags @> ARRAY['paperclip','source:paperclip'] AND title ILIKE '%${issue.identifier ?? ""}%'`,
          limit: 5,
        });
        const match = results.fragments[0];
        if (match) {
          await client.updateFragment(match.id, fragmentData);
          await setFragmentIdMapping(ctx, issue.id, match.id);
          ctx.logger.info(`Updated fragment ${match.id} for ${issue.identifier} (found via search after 409)`);
        } else {
          ctx.logger.error(`Cannot create or update fragment for ${issue.identifier}: ${errMsg}`);
        }
      } else {
        throw err;
      }
    }
  }

  await ctx.metrics.write("usable_sync.issue_to_fragment", 1, { direction: "paperclip_to_usable" });
}

// ---------------------------------------------------------------------------
// Usable -> Paperclip sync
// ---------------------------------------------------------------------------

async function syncFragmentToPaperclip(
  ctx: PluginContext,
  fragment: { id: string; title: string; content: string; tags: string[]; metadata?: Record<string, unknown> },
): Promise<void> {
  const config = await getConfig(ctx);
  if (!isConfigured(config)) return;

  if (!fragment.tags.includes("task") || !fragment.tags.includes("paperclip")) {
    return;
  }

  const instanceTag = `paperclip:${config.instanceTag}`;
  const hasOtherInstance = fragment.tags.some(
    (t) => t.startsWith("paperclip:") && t !== instanceTag && t !== "paperclip",
  );
  if (hasOtherInstance && !fragment.tags.includes(instanceTag)) {
    return;
  }

  const meta = fragment.metadata as SyncMetadata | undefined;

  if (meta?.lastSyncSource === "paperclip") {
    return;
  }

  const frontmatter = parseFrontmatter(fragment.content);
  const paperclipStatus = toPaperclipStatus((frontmatter.status as string) ?? "todo");
  const paperclipPriority = toPaperclipPriority((frontmatter.priority as string) ?? "medium");

  const titleWithoutId = fragment.title.replace(/^[A-Z]+-\d+:\s*/, "");

  if (meta?.paperclipIssueId) {
    const companyId = meta.companyId;
    if (!(await isCompanyAllowed(ctx, companyId))) return;

    const existing = await ctx.issues.get(meta.paperclipIssueId, companyId);
    if (!existing) {
      ctx.logger.warn(`Paperclip issue ${meta.paperclipIssueId} not found for fragment ${fragment.id}`);
      return;
    }

    const patch: Partial<Pick<Issue, "title" | "description" | "status" | "priority" | "assigneeAgentId">> = {};
    if (titleWithoutId && titleWithoutId !== existing.title) {
      patch.title = titleWithoutId;
    }
    if (paperclipStatus !== existing.status) {
      patch.status = paperclipStatus as Issue["status"];
    }
    if (paperclipPriority !== existing.priority) {
      patch.priority = paperclipPriority as Issue["priority"];
    }

    const descriptionMatch = fragment.content.match(/## Description\n([\s\S]*?)(?=\n## |$)/);
    const newDescription = descriptionMatch?.[1]?.trim();
    if (newDescription && newDescription !== existing.description) {
      patch.description = newDescription;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.issues.update(meta.paperclipIssueId, patch, companyId);
      ctx.logger.info(`Updated Paperclip issue ${meta.paperclipIdentifier} from fragment ${fragment.id}`);
    }
  } else {
    // Resolve target company: from metadata, or first allowed, or first available
    let targetCompanyId = meta?.companyId;
    if (!targetCompanyId) {
      const map = await resolveCompanyFilter(ctx);
      if (map && map.size > 0) {
        targetCompanyId = [...map.keys()][0];
      } else {
        const companies = await ctx.companies.list();
        targetCompanyId = companies.length > 0 ? companies[0].id : undefined;
      }
    }
    if (!targetCompanyId) {
      ctx.logger.warn(`No target company found for fragment ${fragment.id}`);
      return;
    }

    const descriptionMatch = fragment.content.match(/## Description\n([\s\S]*?)(?=\n## |$)/);
    const description = descriptionMatch?.[1]?.trim();

    const issue = await ctx.issues.create({
      companyId: targetCompanyId,
      title: titleWithoutId || fragment.title,
      description,
      priority: paperclipPriority as Issue["priority"],
    });

    const client = await getUsableClient(ctx);
    if (!client) return;
    const updatedMetadata: SyncMetadata = {
      paperclipIssueId: issue.id,
      paperclipIdentifier: issue.identifier ?? issue.id,
      paperclipInstance: config.instanceTag,
      companyId: targetCompanyId,
      lastSyncSource: "usable",
      lastSyncedAt: new Date().toISOString(),
      assigneeAgentId: null,
      parentIdentifier: null,
      checkoutRunId: null,
      startedAt: null,
      completedAt: null,
    };

    const updatedTags = [...fragment.tags];
    if (!updatedTags.includes(instanceTag)) {
      updatedTags.push(instanceTag);
    }
    if (!updatedTags.includes("source:paperclip")) {
      updatedTags.push("source:paperclip");
    }

    await client.updateFragment(fragment.id, {
      title: `${issue.identifier ?? issue.id}: ${issue.title}`,
      tags: updatedTags,
      metadata: updatedMetadata as unknown as Record<string, unknown>,
    });

    await setFragmentIdMapping(ctx, issue.id, fragment.id);
    ctx.logger.info(`Created Paperclip issue ${issue.identifier} from fragment ${fragment.id}`);
  }

  await ctx.metrics.write("usable_sync.fragment_to_issue", 1, { direction: "usable_to_paperclip" });
}

// ---------------------------------------------------------------------------
// Company config / org chart sync
// ---------------------------------------------------------------------------

async function syncCompanyConfigToUsable(ctx: PluginContext, companyId: string): Promise<void> {
  const config = await getConfig(ctx);
  if (!isConfigured(config) || !config.configFragmentTypeId) return;
  if (!(await isCompanyAllowed(ctx, companyId))) return;

  const client = await getUsableClient(ctx);
  if (!client) return;

  const companies = await ctx.companies.list();
  const company = companies.find((c) => c.id === companyId);
  if (!company) return;

  const agents = await ctx.agents.list({ companyId });
  const issues = await ctx.issues.list({ companyId, limit: 500 });
  const goals = await ctx.goals.list({ companyId });
  const projects = await ctx.projects.list({ companyId });

  const prefix = (company as { issuePrefix?: string }).issuePrefix ?? "???";
  const now = new Date().toISOString();

  // --- Build org chart tree (JSON) ---
  type AgentNode = {
    id: string; name: string; role: string; title: string | null;
    status: string; adapterType: string; capabilities: string | null;
    budget: { monthlyCents: number; spentCents: number };
    lastHeartbeatAt: string | null; activeIssues: number;
    reports: AgentNode[];
  };

  function buildAgentNode(agent: typeof agents[number]): AgentNode {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title ?? null,
      status: agent.status,
      adapterType: agent.adapterType,
      capabilities: agent.capabilities ?? null,
      budget: { monthlyCents: agent.budgetMonthlyCents, spentCents: agent.spentMonthlyCents },
      lastHeartbeatAt: agent.lastHeartbeatAt ? String(agent.lastHeartbeatAt) : null,
      activeIssues: issues.filter((i) => i.assigneeAgentId === agent.id && !["done", "cancelled"].includes(i.status)).length,
      reports: agents.filter((a) => a.reportsTo === agent.id).map(buildAgentNode),
    };
  }

  const orgChart = agents.filter((a) => !a.reportsTo).map(buildAgentNode);

  // --- Agent status summary ---
  const agentStatus: Record<string, number> = {};
  for (const agent of agents) {
    agentStatus[agent.status] = (agentStatus[agent.status] ?? 0) + 1;
  }

  // --- Task breakdown ---
  const taskStatus: Record<string, number> = {};
  for (const issue of issues) {
    taskStatus[issue.status] = (taskStatus[issue.status] ?? 0) + 1;
  }

  // --- Budget ---
  const totalBudgetCents = (company as { budgetMonthlyCents?: number }).budgetMonthlyCents ?? 0;
  const totalSpentCents = (company as { spentMonthlyCents?: number }).spentMonthlyCents ?? 0;
  const utilization = totalBudgetCents > 0 ? Math.round((totalSpentCents / totalBudgetCents) * 10000) / 100 : 0;

  // --- Goals tree (JSON) ---
  type GoalNode = { id: string; title: string; level: string; status: string; ownerAgent: string | null; children: GoalNode[] };
  function buildGoalNode(goal: typeof goals[number]): GoalNode {
    const ownerAgent = goal.ownerAgentId ? agents.find((a) => a.id === goal.ownerAgentId)?.name ?? null : null;
    return {
      id: goal.id,
      title: goal.title,
      level: goal.level,
      status: goal.status,
      ownerAgent,
      children: goals.filter((g) => g.parentId === goal.id).map(buildGoalNode),
    };
  }
  const goalTree = goals.filter((g) => !g.parentId).map(buildGoalNode);

  // --- Projects with task breakdown (JSON) ---
  const projectData = projects.map((p) => {
    const projectIssues = issues.filter((i) => i.projectId === p.id);
    const breakdown: Record<string, number> = {};
    for (const i of projectIssues) { breakdown[i.status] = (breakdown[i.status] ?? 0) + 1; }
    const leadAgent = p.leadAgentId ? agents.find((a) => a.id === p.leadAgentId)?.name ?? null : null;
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      leadAgent,
      targetDate: p.targetDate ?? null,
      taskBreakdown: breakdown,
    };
  });

  // --- Live state: running agents, checked-out tasks, blockers ---
  const runningAgents = agents.filter((a) => a.status === "running");
  const pausedAgents = agents.filter((a) => a.status === "paused");
  const errorAgents = agents.filter((a) => a.status === "error");
  const pendingApprovalAgents = agents.filter((a) => a.status === "pending_approval");

  const blockedIssues = issues.filter((i) => i.status === "blocked");
  const inProgressIssues = issues.filter((i) => i.status === "in_progress");
  const inReviewIssues = issues.filter((i) => i.status === "in_review");
  const checkedOutIssues = issues.filter((i) => i.checkoutRunId);

  const agentActivity = agents.map((agent) => {
    const agentIssues = issues.filter((i) => i.assigneeAgentId === agent.id);
    const active = agentIssues.filter((i) => ["in_progress", "in_review"].includes(i.status));
    const blocked = agentIssues.filter((i) => i.status === "blocked");
    const checkedOut = agentIssues.filter((i) => i.checkoutRunId);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      pauseReason: agent.pauseReason ?? null,
      lastHeartbeatAt: agent.lastHeartbeatAt ? String(agent.lastHeartbeatAt) : null,
      currentWork: active.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, status: i.status })),
      blockers: blocked.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title })),
      checkedOut: checkedOut.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title })),
      totalAssigned: agentIssues.filter((i) => !["done", "cancelled"].includes(i.status)).length,
    };
  });

  // --- Attention needed: things the board should look at ---
  const attentionItems: Array<{ type: string; severity: string; message: string; entityId?: string; entityName?: string }> = [];

  for (const agent of errorAgents) {
    attentionItems.push({ type: "agent_error", severity: "high", message: `${agent.name} is in error state`, entityId: agent.id, entityName: agent.name });
  }
  for (const agent of pendingApprovalAgents) {
    attentionItems.push({ type: "pending_approval", severity: "medium", message: `${agent.name} awaiting board approval`, entityId: agent.id, entityName: agent.name });
  }
  for (const agent of pausedAgents) {
    attentionItems.push({ type: "agent_paused", severity: "low", message: `${agent.name} paused${agent.pauseReason ? ` (${agent.pauseReason})` : ""}`, entityId: agent.id, entityName: agent.name });
  }
  for (const issue of blockedIssues) {
    const assignee = issue.assigneeAgentId ? agents.find((a) => a.id === issue.assigneeAgentId)?.name : "unassigned";
    attentionItems.push({ type: "task_blocked", severity: "high", message: `${issue.identifier}: ${issue.title} (${assignee})`, entityId: issue.id, entityName: issue.identifier ?? undefined });
  }
  if (totalBudgetCents > 0 && utilization > 80) {
    attentionItems.push({ type: "budget_warning", severity: utilization > 95 ? "high" : "medium", message: `Budget at ${utilization}% ($${(totalSpentCents / 100).toFixed(2)} / $${(totalBudgetCents / 100).toFixed(2)})` });
  }

  // --- Render content ---
  const lines: string[] = [
    `---`,
    `companyId: "${companyId}"`,
    `companyName: "${company.name}"`,
    `issuePrefix: "${prefix}"`,
    `companyStatus: "${company.status}"`,
    `paperclipInstance: "${config.instanceTag}"`,
    `agentCount: ${agents.length}`,
    `projectCount: ${projects.length}`,
    `goalCount: ${goals.length}`,
    `issueCount: ${issues.length}`,
    `runningAgents: ${runningAgents.length}`,
    `blockedTasks: ${blockedIssues.length}`,
    `attentionItems: ${attentionItems.length}`,
    `updatedAt: "${now}"`,
    `---`,
    ``,
    `# ${company.name} — State Snapshot`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Status | ${company.status} |`,
    `| Agents | ${Object.entries(agentStatus).map(([k, v]) => `${v} ${k}`).join(", ")} |`,
    `| Tasks | ${Object.entries(taskStatus).map(([k, v]) => `${v} ${k}`).join(", ")} |`,
    `| Budget | $${(totalSpentCents / 100).toFixed(2)} / $${(totalBudgetCents / 100).toFixed(2)} (${utilization}%) |`,
    `| Running Now | ${runningAgents.map((a) => a.name).join(", ") || "none"} |`,
    `| Blocked | ${blockedIssues.length} task(s) |`,
    `| Needs Attention | ${attentionItems.length} item(s) |`,
    ``,
  ];

  // --- Attention / Blockers section ---
  if (attentionItems.length > 0) {
    lines.push(`## Attention Required`);
    lines.push(``);
    lines.push("```json");
    lines.push(JSON.stringify({ items: attentionItems }, null, 2));
    lines.push("```");
    lines.push(``);
  }

  // --- Live activity ---
  lines.push(
    `## Agent Activity`,
    ``,
    "```json",
    JSON.stringify({ agents: agentActivity }, null, 2),
    "```",
    ``,
    `## Org Chart`,
    ``,
    "```json",
    JSON.stringify({ agents: orgChart }, null, 2),
    "```",
    ``,
    `## Goals`,
    ``,
    "```json",
    JSON.stringify({ goals: goalTree }, null, 2),
    "```",
    ``,
    `## Projects`,
    ``,
    "```json",
    JSON.stringify({ projects: projectData }, null, 2),
    "```",
    ``,
    `## Agent Status`,
    ``,
    "```json",
    JSON.stringify({
      agentStatus,
      budgetUtilization: {
        monthSpendCents: totalSpentCents,
        monthBudgetCents: totalBudgetCents,
        utilizationPercent: utilization,
      },
    }, null, 2),
    "```",
  );

  const content = lines.join("\n");
  const key = `company-config-${prefix.toLowerCase()}`;

  const tags = [
    "paperclip",
    `paperclip:${config.instanceTag}`,
    "paperclip-config",
    "org-chart",
    "dashboard",
    `company:${prefix.toLowerCase()}`,
    "source:paperclip",
  ];

  const metadata = {
    companyId,
    companyName: company.name,
    issuePrefix: prefix,
    companyStatus: company.status,
    paperclipInstance: config.instanceTag,
    agentCount: agents.length,
    projectCount: projects.length,
    goalCount: goals.length,
    issueCount: issues.length,
    runningAgentCount: runningAgents.length,
    blockedTaskCount: blockedIssues.length,
    attentionItemCount: attentionItems.length,
    agentStatus,
    taskStatus,
    budgetUtilization: { monthSpendCents: totalSpentCents, monthBudgetCents: totalBudgetCents, utilizationPercent: utilization },
    lastSyncSource: "paperclip",
    lastSyncedAt: now,
  };

  const configWorkspace = config.configWorkspaceId || config.usableWorkspaceId;
  const fragmentData = {
    title: `${company.name} — Company Dashboard`,
    content,
    tags,
    metadata,
  };

  // Try to find existing fragment by key
  let existingId: string | null = null;
  const existing = await client.getFragmentByKey(key, configWorkspace);
  if (existing) {
    existingId = existing.id;
  }

  if (existingId) {
    await client.updateFragment(existingId, fragmentData);
    ctx.logger.info(`Updated dashboard fragment for ${company.name}`);
  } else {
    try {
      await client.createFragment({
        workspaceId: configWorkspace,
        fragmentTypeId: config.configFragmentTypeId,
        ...fragmentData,
        key,
      });
      ctx.logger.info(`Created dashboard fragment for ${company.name}`);
    } catch (err) {
      // 409 = key already exists but lookup failed — try listing by tag instead
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("409") || errMsg.includes("Duplicate")) {
        ctx.logger.info(`Fragment key ${key} exists but lookup failed — searching by tag`);
        const results = await client.listFragments({
          workspaceId: configWorkspace,
          query: `tags @> ARRAY['paperclip-config','company:${prefix.toLowerCase()}']`,
          limit: 5,
        });
        const match = results.fragments[0];
        if (match) {
          await client.updateFragment(match.id, fragmentData);
          ctx.logger.info(`Updated dashboard fragment for ${company.name} (found via tag search)`);
        } else {
          ctx.logger.error(`Cannot create or update dashboard fragment for ${company.name}: ${errMsg}`);
        }
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    try {
      const issue = event.payload as Issue;
      await syncIssueToUsable(ctx, issue);
    } catch (error) {
      ctx.logger.error(`Failed to sync issue.created to Usable: ${error}`);
    }
  });

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    try {
      const issue = event.payload as Issue;
      await syncIssueToUsable(ctx, issue);
    } catch (error) {
      ctx.logger.error(`Failed to sync issue.updated to Usable: ${error}`);
    }
  });

  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    try {
      const payload = event.payload as { issueId: string; companyId: string };
      if (!(await isCompanyAllowed(ctx, payload.companyId))) return;

      const issue = await ctx.issues.get(payload.issueId, payload.companyId);
      if (issue) {
        await syncIssueToUsable(ctx, issue);
      }
    } catch (error) {
      ctx.logger.error(`Failed to sync issue.comment.created to Usable: ${error}`);
    }
  });

  // Company dashboard sync on agent/issue/goal/project changes
  const dashboardEvents = [
    "agent.created", "agent.updated", "agent.status_changed",
    "goal.created", "goal.updated",
    "project.created", "project.updated",
  ] as const;

  for (const eventType of dashboardEvents) {
    ctx.events.on(eventType, async (event: PluginEvent) => {
      try {
        await syncCompanyConfigToUsable(ctx, event.companyId);
      } catch (error) {
        ctx.logger.error(`Failed to sync dashboard on ${eventType}: ${error}`);
      }
    });
  }

  // Also refresh dashboard on issue changes (task breakdown)
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    try {
      await syncCompanyConfigToUsable(ctx, event.companyId);
    } catch (error) {
      // Already logged in the issue sync handler
    }
  });

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    try {
      await syncCompanyConfigToUsable(ctx, event.companyId);
    } catch (error) {
      // Already logged in the issue sync handler
    }
  });
}

// ---------------------------------------------------------------------------
// Reconciliation job
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEYS.reconcile, async (_job: PluginJobContext) => {
    const config = await getConfig(ctx);
    if (!isConfigured(config)) return;

    try {
      const client = await getUsableClient(ctx);
      if (!client) return;
      const lastSync = await getLastSyncTime(ctx);

      const query = lastSync
        ? `tags @> ARRAY['paperclip'] AND updated_at >= '${lastSync}'`
        : `tags @> ARRAY['paperclip']`;

      const result = await client.listFragmentsAdvanced({
        workspaceId: config.usableWorkspaceId,
        query,
        limit: 100,
        orderBy: "updated_at ASC",
      });

      let processed = 0;
      for (const fragment of result.fragments) {
        try {
          await syncFragmentToPaperclip(ctx, fragment as {
            id: string;
            title: string;
            content: string;
            tags: string[];
            metadata?: Record<string, unknown>;
          });
          processed++;
        } catch (error) {
          ctx.logger.error(`Reconciliation failed for fragment ${fragment.id}: ${error}`);
        }
      }

      await setLastSyncTime(ctx, new Date().toISOString());
      await ctx.metrics.write("usable_sync.reconciliation", processed, { fragments: String(result.totalCount) });
      ctx.logger.info(`Reconciliation complete: ${processed}/${result.totalCount} fragments processed`);
    } catch (error) {
      ctx.logger.error(`Reconciliation job failed: ${error}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("Usable Sync plugin starting up");

    await registerEventHandlers(ctx);
    await registerJobs(ctx);

    const config = await getConfig(ctx);
    if (config.enabled) {
      ctx.logger.info(
        `Sync enabled: instance=${config.instanceTag}, filter=${config.companyFilter || "all"}, workspace=${config.usableWorkspaceId}`,
      );
    } else {
      ctx.logger.info("Sync disabled — configure and enable in plugin settings");
    }
  },

  async onHealth() {
    const ctx = currentContext;
    if (!ctx) return { status: "degraded" as const, message: "Worker not initialized" };

    const config = await getConfig(ctx);
    if (!config.enabled) {
      return { status: "ok" as const, message: "Sync disabled" };
    }
    if (!config.usableWorkspaceId || !config.usablePatSecretRef) {
      return { status: "degraded" as const, message: "Missing required configuration" };
    }

    const lastSync = await getLastSyncTime(ctx);
    return {
      status: "ok" as const,
      message: `Sync active (instance: ${config.instanceTag})`,
      details: {
        instanceTag: config.instanceTag,
        companyFilter: config.companyFilter || "all",
        workspaceId: config.usableWorkspaceId,
        lastSync: lastSync ?? "never",
      },
    };
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    usableClient = null;
    companyAllowMap = null;
    const ctx = currentContext;
    if (ctx) {
      ctx.logger.info("Config changed — Usable client reset");
    }
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const c = config as Partial<UsableSyncConfig>;

    if (c.enabled) {
      if (!c.usableWorkspaceId) errors.push("Usable Workspace ID is required when sync is enabled");
      if (!c.usablePatSecretRef) errors.push("Usable PAT secret reference is required when sync is enabled");
      if (!c.instanceTag) errors.push("Instance Tag is required when sync is enabled");
      if (!c.taskFragmentTypeId) warnings.push("Task Fragment Type ID not set");
      if (!c.configFragmentTypeId) warnings.push("Config Fragment Type ID not set — org chart sync disabled");
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.usable) {
      throw new Error(`Unknown webhook endpoint: ${input.endpointKey}`);
    }

    const ctx = currentContext;
    if (!ctx) {
      throw new Error("Worker not initialized");
    }

    const config = await getConfig(ctx);
    if (!isConfigured(config)) return;

    const body = input.parsedBody as {
      event?: string;
      fragment?: {
        id: string;
        title: string;
        content: string;
        tags: string[];
        metadata?: Record<string, unknown>;
      };
    } | undefined;

    if (!body?.fragment) {
      ctx.logger.warn("Webhook received without fragment data");
      return;
    }

    const event = body.event ?? "fragment.updated";

    try {
      if (event === "fragment.deleted") {
        const meta = body.fragment.metadata as SyncMetadata | undefined;
        if (meta?.paperclipIssueId && meta?.companyId) {
          await ctx.issues.update(
            meta.paperclipIssueId,
            { status: "cancelled" },
            meta.companyId,
          );
          ctx.logger.info(`Cancelled Paperclip issue ${meta.paperclipIdentifier} (fragment deleted)`);
        }
      } else {
        await syncFragmentToPaperclip(ctx, body.fragment);
      }
    } catch (error) {
      ctx.logger.error(`Webhook processing failed: ${error}`);
    }
  },

  async onShutdown() {
    usableClient = null;
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

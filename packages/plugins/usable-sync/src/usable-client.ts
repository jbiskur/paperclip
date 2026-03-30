/**
 * Usable REST API client for fragment CRUD operations.
 * Auth: Bearer token (PAT format mmesh_<id><key>).
 * API base: https://usable.dev/api
 */

const USABLE_API_BASE = "https://usable.dev/api";

export interface UsableFragment {
  id: string;
  title: string;
  summary?: string;
  content: string;
  tags: string[];
  status: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  fragmentType?: { id: string; name: string };
}

export interface CreateFragmentInput {
  workspaceId: string;
  fragmentTypeId: string;
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  key?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateFragmentInput {
  title?: string;
  summary?: string;
  content?: string;
  tags?: string[];
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface ListFragmentsInput {
  workspaceId: string;
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListFragmentsResponse {
  fragments: UsableFragment[];
  totalCount: number;
  hasMore: boolean;
}

export class UsableClient {
  private pat: string;
  private fetchFn: typeof fetch;

  constructor(pat: string, fetchFn?: typeof fetch) {
    this.pat = pat;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${USABLE_API_BASE}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pat}`,
      "Content-Type": "application/json",
    };

    const response = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Usable API ${method} ${path} failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return (await response.json()) as T;
  }

  async createFragment(input: CreateFragmentInput): Promise<{ fragmentId: string }> {
    return this.request("POST", "/memory-fragments", input);
  }

  async updateFragment(fragmentId: string, input: UpdateFragmentInput): Promise<{ fragmentId: string }> {
    return this.request("PATCH", `/memory-fragments/${fragmentId}`, input);
  }

  async getFragment(fragmentId: string): Promise<UsableFragment> {
    const result = await this.request<{ success?: boolean; fragment?: UsableFragment } | UsableFragment>(
      "GET",
      `/memory-fragments/${fragmentId}`,
    );
    if ("fragment" in result && result.fragment) {
      return result.fragment;
    }
    return result as UsableFragment;
  }

  async getFragmentByKey(key: string, workspaceId: string): Promise<UsableFragment | null> {
    try {
      const result = await this.request<{ success?: boolean; fragment?: UsableFragment } | UsableFragment>(
        "GET",
        `/memory-fragments/${encodeURIComponent(key)}`,
        undefined,
        { workspaceId },
      );
      // API may return { success, fragment } wrapper or direct fragment
      if ("fragment" in result && result.fragment) {
        return result.fragment;
      }
      if ("id" in result) {
        return result as UsableFragment;
      }
      return null;
    } catch {
      return null;
    }
  }

  async listFragments(input: ListFragmentsInput): Promise<ListFragmentsResponse> {
    const query: Record<string, string> = {
      workspaceId: input.workspaceId,
    };
    if (input.limit) query.limit = String(input.limit);
    if (input.offset) query.offset = String(input.offset);
    if (input.sortBy) query.sortBy = input.sortBy;
    if (input.sortOrder) query.sortOrder = input.sortOrder;
    if (input.query) query.query = input.query;

    return this.request("GET", "/memory-fragments", undefined, query);
  }

  async listFragmentsAdvanced(input: {
    workspaceId: string;
    query?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
  }): Promise<ListFragmentsResponse> {
    const query: Record<string, string> = {
      workspaceId: input.workspaceId,
    };
    if (input.limit) query.limit = String(input.limit);
    if (input.offset) query.offset = String(input.offset);
    if (input.query) query.query = input.query;
    if (input.orderBy) query.orderBy = input.orderBy;

    return this.request("GET", "/memory-fragments", undefined, query);
  }

  async deleteFragment(fragmentId: string, archive = true): Promise<void> {
    await this.request("DELETE", `/memory-fragments/${fragmentId}`, { archive });
  }

  async registerWebhook(
    workspaceId: string,
    input: {
      name: string;
      targetUrl: string;
      isActive: boolean;
      events: Record<string, boolean>;
      authEnabled?: boolean;
      authHeaderName?: string;
    },
  ): Promise<unknown> {
    return this.request("POST", `/workspaces/${workspaceId}/webhooks`, input);
  }
}

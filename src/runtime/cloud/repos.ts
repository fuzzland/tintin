export interface RemoteRepo {
  providerRepoId: string;
  name: string;
  url: string;
  defaultBranch: string | null;
  archived?: boolean;
  private?: boolean;
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Repo fetch failed: ${res.status} ${text}`);
  }
  return (await res.json()) as any;
}

export async function fetchGithubRepos(opts: { token: string; apiBaseUrl: string }): Promise<RemoteRepo[]> {
  const repos: RemoteRepo[] = [];
  const perPage = 100;
  for (let page = 1; page <= 5; page++) {
    const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/user/repos?per_page=${perPage}&page=${page}&sort=updated`;
    const data = await fetchJson(url, { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" });
    if (!Array.isArray(data)) break;
    for (const r of data) {
      if (!r || typeof r !== "object") continue;
      repos.push({
        providerRepoId: String(r.id ?? r.node_id ?? ""),
        name: String(r.full_name ?? r.name ?? ""),
        url: String(r.clone_url ?? r.html_url ?? ""),
        defaultBranch: typeof r.default_branch === "string" ? r.default_branch : null,
        archived: Boolean(r.archived),
        private: Boolean(r.private),
      });
    }
    if (data.length < perPage) break;
  }
  return repos;
}

export async function fetchGithubInstallationRepos(opts: { token: string; apiBaseUrl: string }): Promise<RemoteRepo[]> {
  const repos: RemoteRepo[] = [];
  const perPage = 100;
  for (let page = 1; page <= 5; page++) {
    const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/installation/repositories?per_page=${perPage}&page=${page}`;
    const data = await fetchJson(url, { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" });
    const items = Array.isArray(data?.repositories) ? data.repositories : Array.isArray(data) ? data : [];
    if (!Array.isArray(items)) break;
    for (const r of items) {
      if (!r || typeof r !== "object") continue;
      repos.push({
        providerRepoId: String(r.id ?? r.node_id ?? ""),
        name: String(r.full_name ?? r.name ?? ""),
        url: String(r.clone_url ?? r.html_url ?? ""),
        defaultBranch: typeof r.default_branch === "string" ? r.default_branch : null,
        archived: Boolean(r.archived),
        private: Boolean(r.private),
      });
    }
    if (items.length < perPage) break;
  }
  return repos;
}

export async function fetchGitlabRepos(opts: { token: string; apiBaseUrl: string }): Promise<RemoteRepo[]> {
  const repos: RemoteRepo[] = [];
  const perPage = 100;
  for (let page = 1; page <= 5; page++) {
    const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/projects?membership=true&per_page=${perPage}&page=${page}&order_by=last_activity_at`;
    const data = await fetchJson(url, { Authorization: `Bearer ${opts.token}` });
    if (!Array.isArray(data)) break;
    for (const r of data) {
      if (!r || typeof r !== "object") continue;
      repos.push({
        providerRepoId: String(r.id ?? ""),
        name: String(r.path_with_namespace ?? r.name ?? ""),
        url: String(r.http_url_to_repo ?? r.web_url ?? ""),
        defaultBranch: typeof r.default_branch === "string" ? r.default_branch : null,
      });
    }
    if (data.length < perPage) break;
  }
  return repos;
}

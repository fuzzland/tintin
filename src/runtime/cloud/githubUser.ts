export interface GitHubUserInfo {
  id: number;
  login: string;
}

/**
 * Fetch GitHub user information using an access token.
 * @param accessToken - OAuth access token
 * @param apiBaseUrl - GitHub API base URL (default: https://api.github.com)
 */
export async function fetchGitHubUser(
  accessToken: string,
  apiBaseUrl = "https://api.github.com",
): Promise<GitHubUserInfo> {
  const res = await fetch(`${apiBaseUrl}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id?: unknown; login?: unknown };

  if (typeof data.id !== "number" || typeof data.login !== "string") {
    throw new Error("Invalid GitHub user response");
  }

  return { id: data.id, login: data.login };
}

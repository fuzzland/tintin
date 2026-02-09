import type { McpConfig, McpProviderConfig } from "./config.js";

export interface McpProviderActivationPlan {
  activeProviderNames: Set<string>;
  deferredProviderNames: Set<string>;
}

const GITHUB_EXPLICIT_PATTERNS = [/\/mcp\s+github\b/i, /\bmcp\s+github\b/i, /\bgithub\s*mcp\b/i];

const GITHUB_SIGNAL_PATTERNS = [/\bgithub\b/i, /github\.com/i];

const GITHUB_ACTION_PATTERNS = [
  /\b(list|show|check|get|find|open|close|create|update|comment|review|merge|sync|triage)\b/i,
  /(查看|列出|获取|创建|更新|评论|合并|关闭|同步|审查)/u,
];

const GITHUB_TARGET_PATTERNS = [
  /\b(issue|issues|pull\s*request|pull\s*requests|prs?|repository|repositories|repo|repos|branch|branches|commit|commits)\b/i,
  /\b(issue|pr|pull\s*request)#?\d+\b/i,
  /\b(owner|repo|repository)\s*[:=]\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/i,
  /\b(github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i,
  /(仓库|分支|提交|拉取请求|合并请求|问题)/u,
];

const GITHUB_TOOL_HINT_PATTERNS = [
  /\b(create_issue|get_issue|list_issues|create_pull_request|get_pull_request|list_pull_requests|merge_pull_request)\b/i,
  /\bgh\s+(?:pr|issue|repo)\b/i,
];

const GITHUB_OWNER_REPO_LIKE_PATTERN =
  /(^|[\s("'`])([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100})(?=$|[\s)"'`.,!?])/;

const GITHUB_ISSUE_PR_REFERENCE_PATTERNS = [/\b(?:issue|pr|pull\s*request)#?\d+\b/i, /(问题|PR|拉取请求)#?\d+/u];

const NOTION_EXPLICIT_PATTERNS = [/\/mcp\s+notion\b/i, /\bmcp\s+notion\b/i, /\bnotion\s*mcp\b/i];

const NOTION_SIGNAL_PATTERNS = [/\bnotion\b/i, /notion\.(?:so|com)/i];

const NOTION_ACTION_PATTERNS = [
  /\b(search|find|open|fetch|read|create|update|query|list|sync|summarize|write|extract)\b/i,
  /(搜索|查询|读取|打开|创建|更新|写入|同步|整理|总结|提取)/u,
];

const NOTION_TARGET_PATTERNS = [
  /\b(workspace|page|pages|database|databases|document|documents|doc|docs|note|notes|block|blocks|teamspace|comment|comments)\b/i,
  /(工作区|页面|数据库|文档|笔记|块|评论|团队空间)/u,
];

const NOTION_STRONG_TARGET_PATTERNS = [
  /\b(teamspace|block|blocks|database\s*view|database\s*property|data\s*source)\b/i,
  /(团队空间|区块|块|数据库视图|页面属性|数据源)/u,
];

const NOTION_TOOL_HINT_PATTERNS = [
  /\b(notion-search|notion-fetch|notion-create-pages|notion-update-page|notion-move-pages|notion-duplicate-page|notion-create-database)\b/i,
  /\b(notion-update-data-source|notion-query-data-sources|notion-query-database-view|notion-create-comment|notion-get-comments)\b/i,
  /\b(notion-get-teams|notion-get-users|notion-get-user|notion-get-self)\b/i,
];

const NOTION_URL_PATTERN = /https?:\/\/(?:www\.)?notion\.(?:so|com)\//i;

function hasPromptMatch(prompt: string, patterns: RegExp[]): boolean {
  if (!prompt) return false;
  const normalized = prompt.normalize("NFKC");
  return patterns.some((pattern) => pattern.test(normalized));
}

function hasHighConfidenceGithubIntent(prompt: string): boolean {
  if (hasPromptMatch(prompt, GITHUB_EXPLICIT_PATTERNS)) return true;
  if (hasPromptMatch(prompt, GITHUB_TOOL_HINT_PATTERNS)) return true;
  const hasAction = hasPromptMatch(prompt, GITHUB_ACTION_PATTERNS);
  const hasTarget = hasPromptMatch(prompt, GITHUB_TARGET_PATTERNS);
  if (!hasAction || !hasTarget) return false;
  const hasSignal = hasPromptMatch(prompt, GITHUB_SIGNAL_PATTERNS);
  if (hasSignal) return true;
  const normalized = prompt.normalize("NFKC");
  if (GITHUB_OWNER_REPO_LIKE_PATTERN.test(normalized)) return true;
  if (hasPromptMatch(normalized, GITHUB_ISSUE_PR_REFERENCE_PATTERNS)) return true;
  return false;
}

function hasHighConfidenceNotionIntent(prompt: string): boolean {
  if (hasPromptMatch(prompt, NOTION_EXPLICIT_PATTERNS)) return true;
  if (hasPromptMatch(prompt, NOTION_TOOL_HINT_PATTERNS)) return true;
  const hasAction = hasPromptMatch(prompt, NOTION_ACTION_PATTERNS);
  if (!hasAction) return false;
  const normalized = prompt.normalize("NFKC");
  const hasSignal = hasPromptMatch(prompt, NOTION_SIGNAL_PATTERNS);
  if (hasSignal) {
    const hasTarget = hasPromptMatch(prompt, NOTION_TARGET_PATTERNS);
    if (NOTION_URL_PATTERN.test(normalized)) return true;
    return hasTarget;
  }
  return hasPromptMatch(normalized, NOTION_STRONG_TARGET_PATTERNS);
}

function isPromptScopedProvider(provider: McpProviderConfig): boolean {
  return provider.type === "github" || provider.type === "notion";
}

function isPromptScopedProviderRequested(provider: McpProviderConfig, prompt: string): boolean {
  if (provider.type === "github") {
    return hasHighConfidenceGithubIntent(prompt);
  }
  if (provider.type === "notion") {
    return hasHighConfidenceNotionIntent(prompt);
  }
  return true;
}

export function resolveMcpProviderActivation(
  config: McpConfig | null | undefined,
  prompt: string,
): McpProviderActivationPlan {
  const activeProviderNames = new Set<string>();
  const deferredProviderNames = new Set<string>();
  if (!config) return { activeProviderNames, deferredProviderNames };

  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;
    if (!isPromptScopedProvider(provider)) {
      activeProviderNames.add(name);
      continue;
    }
    if (isPromptScopedProviderRequested(provider, prompt)) {
      activeProviderNames.add(name);
      continue;
    }
    deferredProviderNames.add(name);
  }

  return {
    activeProviderNames,
    deferredProviderNames,
  };
}

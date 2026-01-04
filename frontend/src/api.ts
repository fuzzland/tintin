export function withToken(path: string, token: string | null): string {
  if (!token) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function fetchJson<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(withToken(path, token));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return (await res.json()) as T;
}

export function createEventSource(path: string, token: string | null): EventSource {
  return new EventSource(withToken(path, token));
}

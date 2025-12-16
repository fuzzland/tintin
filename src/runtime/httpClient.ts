import process from "node:process";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

function envHasProxy(): boolean {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

const proxyAgent = envHasProxy() ? new EnvHttpProxyAgent() : null;

export const fetchWithProxy: typeof undiciFetch = (input, init) => {
  if (!proxyAgent) return undiciFetch(input, init);
  if (init && "dispatcher" in init && init.dispatcher) return undiciFetch(input, init);
  const nextInit = init ? { ...init, dispatcher: proxyAgent } : { dispatcher: proxyAgent };
  return undiciFetch(input, nextInit);
};


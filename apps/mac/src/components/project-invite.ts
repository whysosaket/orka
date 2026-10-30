export function normalizeServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid service URL");
  return url.href.replace(/\/$/, "");
}

export function sameServiceUrl(left: string, right: string): boolean {
  try {
    return normalizeServiceUrl(left) === normalizeServiceUrl(right);
  } catch {
    return false;
  }
}

export function parseProjectInvite(value: string): {
  token: string;
  serviceUrl?: string;
} {
  const input = value.trim();
  if (/^[a-f0-9]{48}$/.test(input)) return { token: input };
  try {
    const url = new URL(input);
    if (url.hash || url.username || url.password || input.length > 2048)
      throw new Error();
    if (url.protocol === "orka:" && url.hostname === "join" && !url.port) {
      const token = url.pathname.match(/^\/([a-f0-9]{48})$/)?.[1];
      if (
        !token ||
        [...url.searchParams.keys()].some((key) => key !== "server") ||
        url.searchParams.getAll("server").length > 1
      )
        throw new Error();
      const server = url.searchParams.get("server");
      if (server !== null) {
        const serviceUrl = normalizeServiceUrl(server);
        if (new URL(serviceUrl).pathname !== "/") throw new Error();
        return { token, serviceUrl };
      }
      return { token };
    }
    const token = url.pathname.match(/^\/join\/([a-f0-9]{48})$/)?.[1];
    if (!token || url.search) throw new Error();
    return { token, serviceUrl: normalizeServiceUrl(url.origin) };
  } catch {
    throw new Error("Paste a valid Orka invite link or token.");
  }
}

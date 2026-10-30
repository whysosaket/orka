import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServiceMode, Snapshot } from "../types.js";
import { normalizeServiceUrl, sameServiceUrl } from "./project-invite.js";

export interface AuthCapabilities {
  auth: { password: boolean; github: boolean; magicLink: boolean };
}
const buildCloudUrl =
  import.meta.env.VITE_ORKA_CLOUD_URL?.trim() || "https://api.tryorka.ai";

export function useAccount(config: Snapshot["config"]) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<ServiceMode>("cloud");
  const [cloudUrl, setCloudUrl] = useState(buildCloudUrl);
  const [selfHostedUrl, setSelfHostedUrl] = useState("");
  const [minutes, setMinutes] = useState(15);
  const [pending, setPending] = useState<"github" | "magic-link" | null>(null);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(
    null,
  );
  const [connectionError, setConnectionError] = useState("");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const lastAuthAction = useRef<(() => Promise<void>) | null>(null);
  const apiUrl = config?.apiUrl;
  const syncMinutes = config?.syncMinutes;
  const savedMode = config?.mode;
  const savedCloud = config?.cloudUrl;
  const savedSelfHosted = config?.selfHostedUrl;
  const url = mode === "cloud" ? cloudUrl : selfHostedUrl;

  useEffect(() => {
    if (apiUrl !== undefined) {
      const nextMode = savedMode ?? "cloud";
      setMode(nextMode);
      setCloudUrl(
        savedCloud || (nextMode === "cloud" ? apiUrl : buildCloudUrl),
      );
      setSelfHostedUrl(
        savedSelfHosted || (nextMode === "self-hosted" ? apiUrl : ""),
      );
    }
    if (syncMinutes !== undefined) setMinutes(syncMinutes);
  }, [apiUrl, syncMinutes, savedMode, savedCloud, savedSelfHosted]);

  useEffect(() => {
    let active = true;
    setCapabilities(null);
    setConnectionError("");
    if (!url) return;
    const timer = window.setTimeout(() => {
      void invoke<AuthCapabilities>("auth_capabilities", { apiUrl: url.trim() })
        .then((result) => {
          if (active) setCapabilities(result);
        })
        .catch((error) => {
          if (active) setConnectionError(String(error));
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [url, connectionAttempt]);

  const rememberedUrl = (draft: string, saved = "") => {
    try {
      normalizeServiceUrl(draft.trim());
      return draft.trim();
    } catch {
      return saved;
    }
  };
  const connection = () => ({
    apiUrl: url.trim(),
    mode,
    // Unfinished input for the other service must not block this sign-in.
    cloudUrl:
      mode === "cloud"
        ? cloudUrl.trim()
        : rememberedUrl(cloudUrl, config?.cloudUrl),
    selfHostedUrl:
      mode === "self-hosted"
        ? selfHostedUrl.trim()
        : rememberedUrl(selfHostedUrl, config?.selfHostedUrl),
    syncMinutes: minutes,
  });
  const saveInterval = () =>
    invoke("configure", { config: { ...config, syncMinutes: minutes } });
  const configure = () => invoke("configure", { config: connection() });
  const connect = async () => {
    try {
      normalizeServiceUrl(url.trim());
    } catch {
      throw new Error(
        "Enter a valid server address, such as https://orka.your-team.com.",
      );
    }
    // A failed capability check must not replace the saved working connection.
    const result = await invoke<AuthCapabilities>("auth_capabilities", {
      apiUrl: url.trim(),
    });
    await configure();
    setCapabilities(result);
    setConnectionError("");
  };
  const signIn = async () => {
    lastAuthAction.current = signIn;
    await configure();
    await invoke("sign_in", { email: email.trim(), password });
    setPassword("");
    setPending(null);
    lastAuthAction.current = null;
  };
  const begin = async (method: "github" | "magic-link") => {
    lastAuthAction.current = () => begin(method);
    await configure();
    await invoke("begin_sign_in", {
      method,
      email: method === "magic-link" ? email.trim() : null,
    });
    setPending(method);
  };
  const cancel = async () => {
    await invoke("cancel_sign_in");
    setPending(null);
    setPassword("");
    lastAuthAction.current = null;
  };
  const complete = async (callback: string) => {
    lastAuthAction.current = () => complete(callback);
    await invoke("complete_sign_in", {
      callback,
      code: null,
    });
    setPending(null);
    setPassword("");
    lastAuthAction.current = null;
  };
  const retryKeychain = async () => {
    const saved = await invoke<{ signedIn: boolean }>("retry_sign_in_storage");
    if (!saved.signedIn) {
      if (!lastAuthAction.current) throw new Error("Start sign-in again.");
      await lastAuthAction.current();
      return;
    }
    setPending(null);
    setPassword("");
    lastAuthAction.current = null;
  };
  const switchService = async (inviteService?: string) => {
    const next = connection();
    if (inviteService) {
      next.apiUrl = normalizeServiceUrl(inviteService);
      next.mode = sameServiceUrl(next.apiUrl, cloudUrl)
        ? "cloud"
        : "self-hosted";
      next[next.mode === "cloud" ? "cloudUrl" : "selfHostedUrl"] = next.apiUrl;
    }
    await invoke("auth_capabilities", { apiUrl: next.apiUrl });
    await invoke("switch_service", { config: next });
    setPending(null);
    setPassword("");
  };
  const changeMode = async (next: ServiceMode) => {
    await cancel();
    setMode(next);
  };
  const setUrl = (value: string) => {
    if (mode === "cloud") setCloudUrl(value);
    else setSelfHostedUrl(value);
  };
  return {
    email,
    setEmail,
    password,
    setPassword,
    url,
    setUrl,
    mode,
    changeMode,
    minutes,
    setMinutes,
    saveInterval,
    configure,
    connect,
    configured: Boolean(apiUrl),
    signIn,
    begin,
    complete,
    retryKeychain,
    cancel,
    pending,
    capabilities,
    connectionError,
    retryConnection: () => setConnectionAttempt((attempt) => attempt + 1),
    switchService,
  };
}
export type Account = ReturnType<typeof useAccount>;

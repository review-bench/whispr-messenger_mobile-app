import { AuthService } from "./AuthService";
import { TokenService } from "./TokenService";
import { DeviceService } from "./DeviceService";
import { getApiBaseUrl } from "./apiBase";

type ApiError = Error & { status?: number; body?: unknown };

function getAuthBaseUrl(): string {
  return `${getApiBaseUrl()}/auth/v1`;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  isRetry = false,
): Promise<T> {
  const token = await TokenService.getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-device-type": "mobile",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${getAuthBaseUrl()}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && !isRetry) {
    try {
      await AuthService.refreshTokens();
      return apiFetch<T>(path, options, true);
    } catch {
      // fall through
    }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(
      (body as { message?: string })?.message ?? `HTTP ${response.status}`,
    ) as ApiError;
    error.status = response.status;
    error.body = body;
    throw error;
  }

  if (response.status === 204) return undefined as unknown as T;
  return response.json() as Promise<T>;
}

// ─── 2FA ────────────────────────────────────────────────────────────────────

export interface TwoFASetupResult {
  secret: string;
  qr_code_url: string;
  backup_codes?: string[];
}

export interface TwoFAStatus {
  enabled: boolean;
  setup_at?: string;
}

export const TwoFactorAuthService = {
  /**
   * POST /auth/2fa/setup
   * Initialize 2FA — returns TOTP secret + QR code URL.
   */
  async setup(): Promise<TwoFASetupResult> {
    return apiFetch<TwoFASetupResult>("/2fa/setup", { method: "POST" });
  },

  /**
   * POST /auth/2fa/enable
   * Confirm and enable 2FA with the first TOTP code.
   */
  async enable(code: string): Promise<void> {
    await apiFetch<void>("/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  /**
   * POST /auth/2fa/verify
   * Verify a TOTP code (used during login when 2FA is active).
   */
  async verify(
    code: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    return apiFetch("/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  /**
   * POST /auth/2fa/disable
   * Disable 2FA (requires current TOTP code or backup code).
   */
  async disable(code: string): Promise<void> {
    await apiFetch<void>("/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },

  /**
   * POST /auth/2fa/backup-codes
   * Regenerate backup codes.
   */
  async generateBackupCodes(): Promise<{ backup_codes: string[] }> {
    return apiFetch("/2fa/backup-codes", { method: "POST" });
  },

  /**
   * GET /auth/2fa/status
   * Get 2FA status for the current user.
   */
  async getStatus(): Promise<TwoFAStatus> {
    return apiFetch<TwoFAStatus>("/2fa/status");
  },
};

// ─── Device management ───────────────────────────────────────────────────────

export interface DeviceInfo {
  id: string;
  deviceName: string;
  deviceType: string;
  model?: string;
  osVersion?: string;
  appVersion?: string;
  lastActive: Date | string;
  isVerified: boolean;
  isActive: boolean;
}

export const DeviceManagerService = {
  /**
   * GET /auth/device
   * List all registered devices for the current user.
   */
  async listDevices(): Promise<DeviceInfo[]> {
    const data = await apiFetch<DeviceInfo | DeviceInfo[]>("/device");
    return Array.isArray(data) ? data : [data];
  },

  /**
   * DELETE /auth/device/:deviceId
   * Revoke a device (log it out remotely).
   */
  async revokeDevice(deviceId: string): Promise<void> {
    await apiFetch<void>(`/device/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    });
  },

  async generateQRChallenge(deviceId: string): Promise<string> {
    const token = await TokenService.getAccessToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/plain, application/json",
      "x-device-type": "mobile",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await fetch(
      `${getAuthBaseUrl()}/qr-code/challenge/${encodeURIComponent(deviceId)}`,
      { method: "POST", headers },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const err = new Error(
        (body as { message?: string })?.message ?? `HTTP ${response.status}`,
      ) as ApiError;
      err.status = response.status;
      err.body = body;
      console.error("[QR] generateQRChallenge failed:", response.status, body);
      throw err;
    }

    const text = await response.text();
    console.log(
      "[QR] challenge received, length:",
      text.length,
      "starts:",
      text.slice(0, 30),
    );
    // NestJS sends string primitives as plain text — handle both formats
    try {
      return JSON.parse(text) as string;
    } catch {
      return text;
    }
  },
};

// ─── Signal Protocol keys ────────────────────────────────────────────────────

export interface SignalKeyBundle {
  identity_key: string;
  signed_prekey: {
    key_id: number;
    public_key: string;
    signature: string;
  };
  one_time_prekeys: Array<{
    key_id: number;
    public_key: string;
  }>;
}

export interface SignalHealthStatus {
  prekeys_remaining: number;
  signed_prekey_age_days: number;
  needs_replenishment: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) return true;
  if (typeof e?.message === "string" && /throttlerexception/i.test(e.message))
    return true;
  return false;
}

async function withRetry<T>(
  run: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      attempt += 1;
      if (!isRateLimitError(err) || attempt >= maxAttempts) throw err;
      const backoff = 250 * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }
}

type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  inFlight?: Promise<T>;
};

const devicesCache = new Map<
  string,
  CacheEntry<{ userId: string; deviceIds: string[] }>
>();
const bundleCache = new Map<string, CacheEntry<SignalKeyBundle>>();

export const SignalKeysService = {
  async listDevices(
    userId: string,
  ): Promise<{ userId: string; deviceIds: string[] }> {
    const cacheKey = userId;
    const cached = devicesCache.get(cacheKey);
    const now = Date.now();
    if (cached?.value && cached.expiresAt > now) return cached.value;
    if (cached?.inFlight) return cached.inFlight;

    const inFlight = withRetry(() =>
      apiFetch<{ userId: string; deviceIds: string[] }>(
        `/signal/keys/${encodeURIComponent(userId)}/devices`,
      ),
    );
    devicesCache.set(cacheKey, { expiresAt: now + 15_000, inFlight });
    try {
      const value = await inFlight;
      devicesCache.set(cacheKey, { expiresAt: now + 15_000, value });
      return value;
    } catch (err) {
      devicesCache.delete(cacheKey);
      throw err;
    }
  },
  /**
   * GET /auth/signal/keys/:userId/devices/:deviceId
   * Fetch the key bundle for a specific user+device (for E2E session init).
   */
  async getKeyBundle(
    userId: string,
    deviceId: string,
  ): Promise<SignalKeyBundle> {
    const cacheKey = `${userId}:${deviceId}`;
    const cached = bundleCache.get(cacheKey);
    const now = Date.now();
    if (cached?.value && cached.expiresAt > now) return cached.value;
    if (cached?.inFlight) return cached.inFlight;

    const inFlight = withRetry(async () => {
      const raw = await apiFetch<any>(
        `/signal/keys/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`,
      );

      const identity_key =
        raw?.identity_key ?? raw?.identityKey ?? raw?.identityKey?.publicKey;

      const signed_prekey =
        raw?.signed_prekey ??
        (raw?.signedPreKey
          ? {
              key_id: raw.signedPreKey.keyId,
              public_key: raw.signedPreKey.publicKey,
              signature: raw.signedPreKey.signature,
            }
          : null);

      const one_time_prekeys =
        raw?.one_time_prekeys ??
        (raw?.preKey
          ? [{ key_id: raw.preKey.keyId, public_key: raw.preKey.publicKey }]
          : []);

      if (typeof identity_key !== "string" || identity_key.length === 0) {
        throw new Error("INVALID_SIGNAL_BUNDLE");
      }
      if (!signed_prekey) {
        throw new Error("INVALID_SIGNAL_BUNDLE");
      }
      return {
        identity_key,
        signed_prekey,
        one_time_prekeys,
      };
    });

    bundleCache.set(cacheKey, { expiresAt: now + 30_000, inFlight });
    try {
      const value = await inFlight;
      bundleCache.set(cacheKey, { expiresAt: now + 30_000, value });
      return value;
    } catch (err) {
      bundleCache.delete(cacheKey);
      throw err;
    }
  },

  /**
   * POST /auth/signal/keys/signed-prekey
   * Upload a new signed prekey (rotation).
   */
  async uploadSignedPrekey(signedPrekey: {
    key_id: number;
    public_key: string;
    signature: string;
  }): Promise<void> {
    await apiFetch<void>("/signal/keys/signed-prekey", {
      method: "POST",
      body: JSON.stringify({
        keyId: signedPrekey.key_id,
        publicKey: signedPrekey.public_key,
        signature: signedPrekey.signature,
      }),
    });
  },

  /**
   * POST /auth/signal/keys/prekeys
   * Upload a batch of one-time prekeys.
   */
  async uploadPrekeys(
    prekeys: Array<{ key_id: number; public_key: string }>,
  ): Promise<void> {
    await apiFetch<void>("/signal/keys/prekeys", {
      method: "POST",
      body: JSON.stringify({
        preKeys: prekeys.map((pk) => ({
          keyId: pk.key_id,
          publicKey: pk.public_key,
        })),
      }),
    });
  },

  /**
   * GET /auth/signal/keys/:userId/devices/:deviceId/status
   * Check key health for the current device (how many prekeys remain, rotation needed, etc.).
   */
  async getDeviceHealth(
    userId: string,
    deviceId: string,
  ): Promise<SignalHealthStatus> {
    const data = await withRetry(() =>
      apiFetch<any>(
        `/signal/keys/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}/status`,
      ),
    );
    return {
      prekeys_remaining: data.availablePreKeys,
      signed_prekey_age_days: 0, // Not provided by this endpoint but not critical for replenish check
      needs_replenishment: data.isLow || !data.hasActiveSignedPreKey,
    };
  },

  /**
   * GET /auth/signal/health
   * GLOBAL health check (admin only typically).
   */
  async getGlobalHealth(): Promise<any> {
    return apiFetch<any>("/signal/health");
  },
};

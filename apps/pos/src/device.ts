import { enrollDeviceResponseSchema, errorResponseSchema } from '@autoparts/shared';

/** What an enrolled terminal remembers. The POS phase moves this into the offline store. */
export interface DeviceIdentity {
  tenant: string;
  deviceId: string;
  credential: string;
}

const KEY = 'autoparts.device';
const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export function loadDevice(): DeviceIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as DeviceIdentity);
  } catch {
    return null;
  }
}

export function saveDevice(device: DeviceIdentity): void {
  localStorage.setItem(KEY, JSON.stringify(device));
}

export class EnrollError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Exchanges the one-time enrollment code for this device's credential (ADR 0011). */
export async function enroll(tenant: string, code: string): Promise<DeviceIdentity> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/devices/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant, code }),
    });
  } catch {
    throw new EnrollError('network');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(data);
    throw new EnrollError(parsed.success ? parsed.data.error.code : 'server.error');
  }
  const { deviceId, credential } = enrollDeviceResponseSchema.parse(data);
  const device = { tenant, deviceId, credential };
  saveDevice(device);
  return device;
}

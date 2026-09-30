/** Quote a value as one POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Linux account names accepted by the command menus. */
export function isSafeLinuxUsername(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(value);
}

/** Numeric IP/IPv6/zone tokens as emitted by `ss -n`. */
export function isSafeNetworkAddress(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_.:%-]+$/.test(value)
    && value !== '*';
}

export function isSafePort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 0 && port <= 65535;
}

export function isSafeNetworkLabel(value: string): boolean {
  return value.length <= 32 && /^[A-Za-z0-9_-]*$/.test(value);
}

export function isSafeNetworkCidr(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && (value === '0.0.0.0/0' || value === '::/0' || /^[A-Za-z0-9_.:%/-]+$/.test(value))
    && !/[;&|`$()<>\s]/.test(value);
}

export function isSafePid(value: string): boolean {
  if (!/^\d{1,10}$/.test(value)) return false;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 4_194_304;
}

export function isSafeSystemdUnit(value: string): boolean {
  return value.length > 0 && value.length <= 255 && /^[A-Za-z0-9_.:@-]+$/.test(value);
}

export function isSafeKernelModule(value: string): boolean {
  return value.length > 0 && value.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(value);
}

export function isSafePackageName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && /^[A-Za-z0-9+_.:@~-]+$/.test(value);
}

export function isSafeEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value);
}

export function isSafeKubernetesIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

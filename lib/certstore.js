// Windows certificate-store inspection.
//
// The plugin never installs anything into the OS stores, but scholartools.exe
// (and any other client) may have. This module answers two questions for the
// settings page without needing a certificate API:
//   * is our pinned root present in CurrentUser / LocalMachine Root or CA?
//   * can the user remove it from their own store without elevation?
//
// The stores are backed by these registry keys, which is what reg.exe queries:
//   HKCU\Software\Microsoft\SystemCertificates\<Store>\Certificates\<SHA1>
//   HKLM\Software\Microsoft\SystemCertificates\<Store>\Certificates\<SHA1>
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { SCHOLAR_CA_PEM } from './scholar-ca.js';

const STORES = ['Root', 'CA'];
const HIVES = [
  { hive: 'HKCU', label: 'CurrentUser', elevated: false },
  { hive: 'HKLM', label: 'LocalMachine', elevated: true },
];

export function thumbprintOf(pem = SCHOLAR_CA_PEM) {
  try {
    const certificate = new crypto.X509Certificate(pem);
    // Node's `fingerprint` is the SHA-1 digest, which is the Windows thumbprint.
    return { sha1: certificate.fingerprint.replace(/:/g, ''), sha256: certificate.fingerprint256.replace(/:/g, '') };
  } catch {
    return { sha1: '', sha256: '' };
  }
}

function regQueryKey(path, timeoutMs = 8000) {
  return new Promise((resolve) => {
    // Spawning can be refused outright in a restricted process (piped stdio is
    // blocked by some sandboxes), so the throw is handled like a negative answer.
    try {
      execFile('reg.exe', ['query', path], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          resolve({ exists: false, error: (stderr || error.message || '').trim().slice(0, 200) });
          return;
        }
        resolve({ exists: true, output: String(stdout).trim().slice(0, 400) });
      });
    } catch (error) {
      resolve({ exists: false, error: String(error?.message || error) });
    }
  });
}

export async function scanSystemStores(pem = SCHOLAR_CA_PEM) {
  const { sha1, sha256 } = thumbprintOf(pem);
  const results = [];
  for (const { hive, label, elevated } of HIVES) {
    for (const store of STORES) {
      const path = `HK${hive === 'HKCU' ? 'CU' : 'LM'}\\Software\\Microsoft\\SystemCertificates\\${store}\\Certificates\\${sha1}`;
      const found = sha1 ? await regQueryKey(path) : { exists: false, error: 'no thumbprint' };
      results.push({
        hive,
        store,
        scope: label,
        withinUserScope: !elevated,
        path,
        present: found.exists,
        error: found.exists ? undefined : found.error,
      });
    }
  }
  const disallowed = await scanDisallowed(pem);
  return {
    thumbprintSha1: sha1,
    thumbprintSha256: sha256,
    anyPresent: results.some((entry) => entry.present),
    // "Disabled" is the Disallowed store, not a missing certificate: the cert
    // stays installed, the chain simply stops trusting it.
    systemDisabled: disallowed.anyPresent,
    disallowed: disallowed.results,
    results,
  };
}

export async function scanDisallowed(pem = SCHOLAR_CA_PEM) {
  const { sha1 } = thumbprintOf(pem);
  const results = [];
  for (const { hive, label } of HIVES) {
    const path = `HK${hive === 'HKCU' ? 'CU' : 'LM'}\\Software\\Microsoft\\SystemCertificates\\Disallowed\\Certificates\\${sha1}`;
    const found = sha1 ? await regQueryKey(path) : { exists: false, error: 'no thumbprint' };
    results.push({ hive, scope: label, path, present: found.exists });
  }
  return { results, anyPresent: results.some((entry) => entry.present) };
}

/**
 * Turn the machine-wide trust of this root off and on again without touching
 * the Root store: the certificate goes into `Disallowed`, where the Windows
 * chain engine treats it as explicitly untrusted. scholartools keeps working
 * the moment it is taken back out.
 *
 * Both stores refuse writes to a non-elevated caller (verified on Windows 11:
 * certutil -user -addstore Disallowed also returns ACCESS_DENIED), so this runs
 * one elevated PowerShell through the normal UAC prompt. Declining removes
 * nothing.
 */
export async function setSystemDisallowed(disabled, pem = SCHOLAR_CA_PEM) {
  let certificate;
  try {
    certificate = new crypto.X509Certificate(pem);
  } catch (error) {
    return { ok: false, error: `cannot parse pinned certificate: ${error.message}` };
  }
  const thumbprint = certificate.fingerprint.replace(/:/g, '');
  const base64Der = certificate.raw.toString('base64');
  const script = disabled
    ? [
        "$ErrorActionPreference='Stop'",
        'try {',
        `  $b=[Convert]::FromBase64String('${base64Der}')`,
        '  $c=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($b)',
        "  $s=[System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed','LocalMachine')",
        "  $s.Open('ReadWrite')",
        `  if (-not ($s.Certificates | Where-Object { $_.Thumbprint -eq '${thumbprint}' })) { $s.Add($c) }`,
        '  $s.Close()',
        "  Write-Output 'DISALLOWED_OK'",
        '} catch {',
        "  Write-Output ('ERROR: ' + $_.Exception.Message)",
        '  exit 1',
        '}',
      ].join('\n')
    : [
        "$ErrorActionPreference='Stop'",
        'try {',
        `  $t='${thumbprint}'`,
        "  $s=[System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed','LocalMachine')",
        "  $s.Open('ReadWrite')",
        '  $n=0',
        '  foreach ($x in @($s.Certificates)) { if ($x.Thumbprint -eq $t) { $s.Remove($x); $n++ } }',
        '  $s.Close()',
        "  Write-Output ('RESTORED_OK removed=' + $n)",
        '} catch {',
        "  Write-Output ('ERROR: ' + $_.Exception.Message)",
        '  exit 1',
        '}',
      ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encoded}' -Verb RunAs -Wait`;
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', launcher],
        { timeout: 180000, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.trim().slice(0, 600);
          const denied = /canceled|cancelled|拒绝|denied/i.test(output) || /cancel/i.test(error?.message || '');
          resolve({
            ok: !error && /OK/.test(output),
            disabled,
            scope: 'LocalMachine',
            store: 'Disallowed',
            thumbprint,
            output,
            cancelled: denied && !/OK/.test(output),
            error: error ? error.message : undefined,
          });
        }
      );
    } catch (error) {
      resolve({ ok: false, disabled, scope: 'LocalMachine', store: 'Disallowed', thumbprint, error: String(error?.message || error) });
    }
  });
}

export async function removeFromUserStore(pem = SCHOLAR_CA_PEM, store = 'Root') {
  const { sha1 } = thumbprintOf(pem);
  if (!sha1) return { ok: false, error: 'cannot compute thumbprint' };
  const scope = STORES.includes(store) ? store : 'Root';
  return new Promise((resolve) => {
    try {
      execFile('certutil.exe', ['-user', '-delstore', scope, sha1], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim().slice(0, 600);
        resolve({ ok: !error, scope: 'CurrentUser', store: scope, thumbprint: sha1, output, error: error ? error.message : undefined });
      });
    } catch (error) {
      resolve({ ok: false, scope: 'CurrentUser', store: scope, thumbprint: sha1, error: String(error?.message || error) });
    }
  });
}

/**
 * Removing a machine-wide certificate needs elevation. This starts one elevated
 * certutil through the normal UAC prompt — the user sees and approves it, and
 * nothing is removed if they decline.
 */
export async function removeFromMachineStore(pem = SCHOLAR_CA_PEM, store = 'Root') {
  const { sha1 } = thumbprintOf(pem);
  if (!sha1 || !/^[0-9A-F]+$/i.test(sha1)) return { ok: false, error: 'cannot compute thumbprint' };
  const scope = STORES.includes(store) ? store : 'Root';
  const inner = `Start-Process -FilePath certutil.exe -ArgumentList '-delstore','${scope}','${sha1}' -Verb RunAs -Wait`;
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', inner],
        { timeout: 180000, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.trim().slice(0, 600);
          resolve({ ok: !error, scope: 'LocalMachine', store: scope, thumbprint: sha1, elevated: true, output, error: error ? error.message : undefined });
        }
      );
    } catch (error) {
      resolve({ ok: false, scope: 'LocalMachine', store: scope, thumbprint: sha1, elevated: true, error: String(error?.message || error) });
    }
  });
}

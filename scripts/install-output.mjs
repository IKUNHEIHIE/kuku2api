import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export const quietInstall = () => process.env.KUKU_INSTALLER_QUIET === '1';
export const progress = (...values) => { if (!quietInstall()) console.log(...values); };

export async function consoleAddress(port, { host = '127.0.0.1', interfaces = networkInterfaces(), request = fetch } = {}) {
  let address = host;
  if (host === '0.0.0.0' || host === '::') {
    const local = Object.values(interfaces).flat().filter(entry => !entry.internal && isIP(entry.address) === 4).map(entry => entry.address);
    address = local[0] ?? '127.0.0.1';
    // A cloud instance's inbound public IP may differ from its outbound NAT IP.
    // Read only the public-IP metadata field before consulting an external service.
    for (const [url, timeout] of [['http://169.254.169.254/latest/meta-data/public-ipv4', 800], ['https://api.ipify.org', 1200]]) {
      try {
        const response = await request(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
        if (response.ok) {
          const detected = (await response.text()).trim();
          if (isIP(detected) === 4) { address = detected; break; }
        }
      } catch { /* IP discovery must not fail an otherwise successful install. */ }
    }
  }
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

export async function installSummary({ port, token, host, language }) {
  const url = await consoleAddress(port, { host });
  console.log(language === 'zh' ? `控制台地址：${url}` : `Console address: ${url}`);
  console.log(language === 'zh' ? `管理员密钥：${token}` : `Administrator key: ${token}`);
}

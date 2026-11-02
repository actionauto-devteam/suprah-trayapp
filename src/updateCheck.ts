import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseFeedVersion } from './version';

const RELEASE_DOWNLOAD_BASE = 'https://github.com/actionauto-devteam/suprah-trayapp/releases/latest/download';
const FEED_TIMEOUT_MS = 15_000;
const FEED_MAX_BYTES = 65_536;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const getFeedName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml');
const getInstallerName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'SuprahTraySetup.dmg' : 'SuprahTraySetup.exe');

export const getFeedUrl = (platform: NodeJS.Platform = process.platform): string =>
  `${RELEASE_DOWNLOAD_BASE}/${getFeedName(platform)}`;

export const getInstallerUrl = (platform: NodeJS.Platform = process.platform): string =>
  `${RELEASE_DOWNLOAD_BASE}/${getInstallerName(platform)}`;

const fetchFeedText = async (): Promise<string | null> => {
  try {
    const { data } = await axios.get(getFeedUrl(), {
      timeout: FEED_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(raw) => raw],
      maxContentLength: FEED_MAX_BYTES,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
};

export const fetchLatestVersion = async (): Promise<string | null> => parseFeedVersion(await fetchFeedText());

export const parseFeedFileSha512 = (text: string, fileName: string): string | null => {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const url = /^\s*-?\s*url:\s*["']?([^"'\s]+)["']?\s*$/.exec(lines[i]);
    if (!url || url[1] !== fileName) continue;
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      if (/^\s*-\s*url:/.test(lines[j])) break;
      const sha = /^\s*sha512:\s*["']?([^"'\s]+)["']?\s*$/.exec(lines[j]);
      if (sha) return sha[1];
    }
  }
  const topPath = /^path:\s*["']?([^"'\s]+)["']?\s*$/m.exec(clean);
  const topSha = /^sha512:\s*["']?([^"'\s]+)["']?\s*$/m.exec(clean);
  return topPath && topSha && topPath[1] === fileName ? topSha[1] : null;
};

export const fetchInstallerSha512 = async (platform: NodeJS.Platform = process.platform): Promise<string | null> => {
  const text = await fetchFeedText();
  return text ? parseFeedFileSha512(text, getInstallerName(platform)) : null;
};

export const downloadInstaller = async (
  expectedSha512: string | null,
  onProgress: (percent: number | null) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<string> => {
  const dir = path.join(os.tmpdir(), 'suprah-tray-update');
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, getInstallerName(platform));
  const response = await axios.get(getInstallerUrl(platform), {
    responseType: 'stream',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 10,
    headers: { 'Cache-Control': 'no-cache' },
  });
  const total = Number(response.headers['content-length']) || 0;
  const hash = crypto.createHash('sha512');
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(target);
    response.data.on('data', (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      onProgress(total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null);
    });
    response.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    response.data.pipe(out);
  });
  if (expectedSha512 && hash.digest('base64') !== expectedSha512) {
    await fs.promises.unlink(target).catch(() => {});
    throw new Error('The downloaded update did not match the release.');
  }
  return target;
};

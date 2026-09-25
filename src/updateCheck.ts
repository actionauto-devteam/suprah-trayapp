import axios from 'axios';
import { parseFeedVersion } from './version';

const RELEASE_DOWNLOAD_BASE = 'https://github.com/actionauto-devteam/suprah-trayapp/releases/latest/download';
const FEED_TIMEOUT_MS = 15_000;
const FEED_MAX_BYTES = 65_536;

const getFeedName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml');
const getInstallerName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'SuprahTraySetup.dmg' : 'SuprahTraySetup.exe');

export const getFeedUrl = (platform: NodeJS.Platform = process.platform): string =>
  `${RELEASE_DOWNLOAD_BASE}/${getFeedName(platform)}`;

export const getInstallerUrl = (platform: NodeJS.Platform = process.platform): string =>
  `${RELEASE_DOWNLOAD_BASE}/${getInstallerName(platform)}`;

export const fetchLatestVersion = async (): Promise<string | null> => {
  try {
    const { data } = await axios.get(getFeedUrl(), {
      timeout: FEED_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(raw) => raw],
      maxContentLength: FEED_MAX_BYTES,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return parseFeedVersion(data);
  } catch {
    return null;
  }
};

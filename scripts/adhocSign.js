// electron-builder afterSign hook — ad-hoc code-signs the packaged .app on macOS.
// Free, no Apple Developer account needed. Tries to give the app a consistent code
// identity across rebuilds (unlike fully unsigned, where macOS's TCC permission
// grants — e.g. Screen Recording — have repeatedly failed to survive an update).
// Not a substitute for a real Developer ID: still unnotarized, so Gatekeeper will
// still warn on first launch on other Macs, same as today.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[adhocSign] Ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};

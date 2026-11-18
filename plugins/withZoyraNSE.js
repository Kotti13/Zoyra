/**
 * Zoyra iOS Notification Service Extension (config plugin; runs during `expo prebuild` / EAS Build — never edit ios/).
 *
 * Adds the `ZoyraNotificationService` app-extension target (Swift sources in plugins/zoyra-nse/) that decrypts the
 * preview of end-to-end encrypted chat pushes (see src/lib/e2ee/README.md › Notification previews):
 *   - copies NotificationService.swift, ZoyraE2EE.swift, ZoyraKeychain.swift + Info.plist + entitlements into
 *     ios/ZoyraNotificationService/ and creates the target (embedded in the app via "Copy Files" → PlugIns),
 *   - entitlements for BOTH the app and the extension:
 *       keychain-access-groups  [$(AppIdentifierPrefix)com.zoyra.app.shared]   ← first entry = default keychain group,
 *                               so expo-secure-store items written without an accessGroup land in it and the
 *                               extension can read this device's key (src/lib/e2ee/keystore.ts writeNseKey)
 *       com.apple.security.application-groups  [group.com.zoyra.app]
 *   - declares the extension for EAS credentials (extra.eas.build.experimental.ios.appExtensions,
 *     https://docs.expo.dev/build-reference/app-extensions/).
 *
 * The extension only needs CryptoKit / Security / UserNotifications (system frameworks, iOS 15.1+).
 */
/* global __dirname */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'ZoyraNotificationService';
const SRC = path.join(__dirname, 'zoyra-nse');
const SOURCES = ['NotificationService.swift', 'ZoyraE2EE.swift', 'ZoyraKeychain.swift'];
const APP_GROUP = 'group.com.zoyra.app';
const KEYCHAIN_GROUP = '$(AppIdentifierPrefix)com.zoyra.app.shared';
const DEPLOYMENT_TARGET = '15.1';

const bundleIdOf = (config) => {
  const id = config.ios && config.ios.bundleIdentifier;
  if (!id) throw new Error('[withZoyraNSE] ios.bundleIdentifier is required');
  return id;
};

function entitlements() {
  return {
    'keychain-access-groups': [KEYCHAIN_GROUP],
    'com.apple.security.application-groups': [APP_GROUP],
  };
}

/** Shared keychain group (first!) + app group on the main app. */
function withAppEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const e = cfg.modResults;
    const groups = Array.isArray(e['keychain-access-groups']) ? e['keychain-access-groups'].filter((g) => g !== KEYCHAIN_GROUP) : [];
    e['keychain-access-groups'] = [KEYCHAIN_GROUP, ...groups];
    const apps = Array.isArray(e['com.apple.security.application-groups']) ? e['com.apple.security.application-groups'] : [];
    if (!apps.includes(APP_GROUP)) apps.push(APP_GROUP);
    e['com.apple.security.application-groups'] = apps;
    return cfg;
  });
}

/** EAS needs to know about the extension before the Xcode project exists (credentials). */
function withEasDeclaration(config) {
  const bundleIdentifier = `${bundleIdOf(config)}.${TARGET}`;
  config.extra = config.extra || {};
  const eas = (config.extra.eas = config.extra.eas || {});
  const build = (eas.build = eas.build || {});
  const experimental = (build.experimental = build.experimental || {});
  const ios = (experimental.ios = experimental.ios || {});
  const list = Array.isArray(ios.appExtensions) ? ios.appExtensions.filter((x) => x && x.targetName !== TARGET) : [];
  list.push({ targetName: TARGET, bundleIdentifier, entitlements: entitlements() });
  ios.appExtensions = list;
  return config;
}

function plist(obj) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = Object.entries(obj)
    .map(([k, v]) => `  <key>${esc(k)}</key>\n  <array>\n${v.map((x) => `    <string>${esc(x)}</string>`).join('\n')}\n  </array>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function withExtensionFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of SOURCES) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
      fs.copyFileSync(path.join(SRC, 'Info.plist'), path.join(dir, `${TARGET}-Info.plist`));
      fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), plist(entitlements()));
      return cfg;
    },
  ]);
}

function withExtensionTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    if (project.pbxTargetByName(TARGET)) return cfg; // idempotent (prebuild without --clean)

    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

    // Group with the extension files, attached to the project's main group.
    const files = [...SOURCES, `${TARGET}-Info.plist`, `${TARGET}.entitlements`];
    const group = project.addPbxGroup(files, TARGET, TARGET);
    const mainGroupId = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroupId);

    const bundleId = `${bundleIdOf(cfg)}.${TARGET}`;
    const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);
    project.addBuildPhase(SOURCES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    // Main app target settings to copy (team, versions).
    const configs = project.pbxXCBuildConfigurationSection();
    let team = null;
    let marketing = cfg.version || '1.0.0';
    let build = (cfg.ios && cfg.ios.buildNumber) || '1';
    for (const key of Object.keys(configs)) {
      const bs = configs[key] && configs[key].buildSettings;
      if (!bs || bs.PRODUCT_NAME === `"${TARGET}"`) continue;
      if (bs.PRODUCT_BUNDLE_IDENTIFIER && String(bs.PRODUCT_BUNDLE_IDENTIFIER).replace(/"/g, '') === bundleIdOf(cfg)) {
        team = bs.DEVELOPMENT_TEAM || team;
        marketing = bs.MARKETING_VERSION || marketing;
        build = bs.CURRENT_PROJECT_VERSION || build;
      }
    }
    for (const key of Object.keys(configs)) {
      const bs = configs[key] && configs[key].buildSettings;
      if (!bs || bs.PRODUCT_NAME !== `"${TARGET}"`) continue;
      bs.INFOPLIST_FILE = `"${TARGET}/${TARGET}-Info.plist"`;
      bs.CODE_SIGN_ENTITLEMENTS = `"${TARGET}/${TARGET}.entitlements"`;
      bs.CODE_SIGN_STYLE = 'Automatic';
      bs.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
      bs.TARGETED_DEVICE_FAMILY = '"1,2"';
      bs.SWIFT_VERSION = '5.0';
      bs.MARKETING_VERSION = marketing;
      bs.CURRENT_PROJECT_VERSION = build;
      bs.GENERATE_INFOPLIST_FILE = 'NO';
      bs.SKIP_INSTALL = 'YES';
      bs.APPLICATION_EXTENSION_API_ONLY = 'YES';
      if (team) bs.DEVELOPMENT_TEAM = team;
    }
    return cfg;
  });
}

module.exports = function withZoyraNSE(config) {
  config = withEasDeclaration(config);
  config = withAppEntitlements(config);
  config = withExtensionFiles(config);
  config = withExtensionTarget(config);
  return config;
};

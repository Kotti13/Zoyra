/**
 * Zoyra native incoming calls (config plugin; runs during `expo prebuild` / EAS Build, never edit ios/ or android/).
 *
 * iOS
 *   - copies plugins/zoyra-calls/ios/ZoyraVoip.{h,m} into the app target (PushKit → CallKit, natively),
 *   - imports it in the Swift bridging header and calls `ZoyraVoip.start()` from AppDelegate
 *     didFinishLaunching, so a VoIP push is reported to CallKit even when JavaScript isn't running,
 *   - adds the `voip` + `audio` background modes (react-native-callkeep's plugin also adds `voip`).
 *   CallKit plays `zoyra_ring.wav`, bundled by the expo-notifications plugin `sounds` list.
 *
 * Android
 *   - copies plugins/zoyra-calls/android/*.kt into `<package>.zoyracall` (NativeModules.ZoyraCall: the
 *     full-screen CallStyle ringing notification on the `zoyra_calls_v1` channel, lock-screen flags, ringer mode),
 *   - registers ZoyraCallPackage in MainApplication, hooks MainActivity (show over the lock screen when opened
 *     from the call notification), declares the Decline receiver and the headless JS task service.
 *   The ringtone is res/raw/zoyra_ring.wav, copied by the expo-notifications plugin `sounds` list.
 */
/* global __dirname */
const fs = require('fs');
const path = require('path');
const { AndroidConfig, IOSConfig, withAndroidManifest, withAppDelegate, withDangerousMod, withInfoPlist, withMainActivity, withMainApplication, withXcodeProject } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const SRC = path.join(__dirname, 'zoyra-calls');
const IOS_FILES = ['ZoyraVoip.h', 'ZoyraVoip.m'];
const ANDROID_FILES = ['ZoyraCallNotifier.kt', 'ZoyraCallModule.kt', 'ZoyraCallActionReceiver.kt', 'ZoyraCallTaskService.kt', 'ZoyraCallPackage.kt'];

/* ------------------------------------------------------------------ iOS */

function withIosSources(config) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const dir = path.join(cfg.modRequest.platformProjectRoot, projectName);
      for (const f of IOS_FILES) fs.copyFileSync(path.join(SRC, 'ios', f), path.join(dir, f));
      // Swift bridging header: expose ZoyraVoip to AppDelegate.swift.
      const header = fs.readdirSync(dir).find((f) => f.endsWith('-Bridging-Header.h'));
      if (!header) throw new Error('[withZoyraCalls] No Swift bridging header found in ios/' + projectName);
      const headerPath = path.join(dir, header);
      const src = fs.readFileSync(headerPath, 'utf8');
      if (!src.includes('#import "ZoyraVoip.h"')) fs.writeFileSync(headerPath, `${src.trimEnd()}\n#import "ZoyraVoip.h"\n`);
      return cfg;
    },
  ]);
  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const filepath = `${projectName}/ZoyraVoip.m`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project });
    }
    return cfg;
  });
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') throw new Error('[withZoyraCalls] Expected a Swift AppDelegate');
    cfg.modResults.contents = mergeContents({
      src: cfg.modResults.contents,
      newSrc: '    ZoyraVoip.start()',
      tag: 'zoyra-voip-start',
      anchor: /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
      offset: 0,
      comment: '//',
    }).contents;
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    const modes = Array.isArray(cfg.modResults.UIBackgroundModes) ? cfg.modResults.UIBackgroundModes : [];
    for (const m of ['audio', 'voip']) if (!modes.includes(m)) modes.push(m);
    cfg.modResults.UIBackgroundModes = modes;
    return cfg;
  });
  return config;
}

/* ------------------------------------------------------------------ Android */

function packageOf(cfg) {
  const pkg = AndroidConfig.Package.getPackage(cfg);
  if (!pkg) throw new Error('[withZoyraCalls] android.package is required');
  return pkg;
}

function withAndroidSources(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const pkg = packageOf(cfg);
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', ...pkg.split('.'), 'zoyracall');
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ANDROID_FILES) {
        const src = fs.readFileSync(path.join(SRC, 'android', f), 'utf8').replace(/__PACKAGE__/g, pkg);
        fs.writeFileSync(path.join(dir, f), src);
      }
      return cfg;
    },
  ]);
  config = withMainApplication(config, (cfg) => {
    const pkg = packageOf(cfg);
    cfg.modResults.contents = mergeContents({
      src: cfg.modResults.contents,
      newSrc: `          add(${pkg}.zoyracall.ZoyraCallPackage())`,
      tag: 'zoyra-call-package',
      anchor: /PackageList\(this\)\.packages\.apply\s*\{/,
      offset: 1,
      comment: '//',
    }).contents;
    return cfg;
  });
  config = withMainActivity(config, (cfg) => {
    const pkg = packageOf(cfg);
    cfg.modResults.contents = mergeContents({
      src: cfg.modResults.contents,
      newSrc: `    ${pkg}.zoyracall.ZoyraCallNotifier.attach(this)`,
      tag: 'zoyra-call-lockscreen',
      anchor: /super\.onCreate\((null|savedInstanceState)\)/,
      offset: 1,
      comment: '//',
    }).contents;
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.receiver = app.receiver ?? [];
    if (!app.receiver.some((r) => r.$['android:name'] === '.zoyracall.ZoyraCallActionReceiver')) {
      app.receiver.push({ $: { 'android:name': '.zoyracall.ZoyraCallActionReceiver', 'android:exported': 'false' } });
    }
    app.service = app.service ?? [];
    if (!app.service.some((s) => s.$['android:name'] === '.zoyracall.ZoyraCallTaskService')) {
      app.service.push({ $: { 'android:name': '.zoyracall.ZoyraCallTaskService', 'android:exported': 'false' } });
    }
    // MainActivity shows over the lock screen only at runtime, while a call rings / is on (ZoyraCallNotifier).
    return cfg;
  });
  return config;
}

module.exports = function withZoyraCalls(config) {
  config = withIosSources(config);
  config = withAndroidSources(config);
  return config;
};

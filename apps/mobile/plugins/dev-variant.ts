/**
 * Lets a development build and a release build of Raphael stay installed side by side.
 *
 * Both builds come from the same generated native projects, so the split follows the build type
 * rather than anything read at prebuild time: Android's debug build type and iOS's Debug
 * configuration install under a `.dev` identifier with a "Dev" label, while release keeps the real
 * identity. Moving between `pnpm ios` and `pnpm release:ios` therefore never needs a fresh prebuild.
 *
 * On both platforms the label is a variable the build fills in: a manifest placeholder on Android
 * and a build setting on iOS, each read by the launcher-facing name.
 *
 * Each install has its own sandbox, so the development build's database and saved connection never
 * touch the release build's.
 */

import {
  type ConfigPlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withInfoPlist,
  withXcodeProject,
} from 'expo/config-plugins.js';

export const DEV_ID_SUFFIX = '.dev';

/** The manifest placeholder the Android application label reads, set per build type. */
export const LABEL_PLACEHOLDER = 'appLabel';

/** The Xcode build setting the Info.plist display name reads, set per configuration. */
export const DISPLAY_NAME_SETTING = 'RAPHAEL_DISPLAY_NAME';

export const devName = (name: string): string => `${name} Dev`;

const groovyString = (value: string): string =>
  `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/**
 * Gives the app's `build.gradle` a default label and a debug build type with the development
 * suffix and label. React Native derives `debugOptimized` from `debug` with `initWith`, so it
 * inherits both.
 */
export const applyAndroidBuildTypes = (gradle: string, name: string): string => {
  if (gradle.includes('applicationIdSuffix')) {
    return gradle;
  }
  const defaultConfig = /(defaultConfig\s*\{)/u;
  const debugBuildType = /(buildTypes\s*\{\s*debug\s*\{)/u;
  if (!defaultConfig.test(gradle) || !debugBuildType.test(gradle)) {
    throw new Error('dev-variant: app/build.gradle has no defaultConfig or buildTypes.debug block');
  }
  const label = (value: string) =>
    `manifestPlaceholders['${LABEL_PLACEHOLDER}'] = ${groovyString(value)}`;
  return gradle
    .replace(defaultConfig, `$1\n        ${label(name)}`)
    .replace(
      debugBuildType,
      `$1\n            applicationIdSuffix '${DEV_ID_SUFFIX}'\n            ${label(devName(name))}`,
    );
};

interface BuildConfiguration {
  readonly name: string;
  readonly buildSettings: Record<string, unknown>;
}

/**
 * Gives every app-target configuration its display name, and the Debug one the development bundle
 * identifier. App-target configurations are the ones that carry a bundle identifier; project-level
 * configurations are left alone.
 */
export const applyIosBuildConfigurations = (
  configurations: Iterable<BuildConfiguration>,
  { bundleIdentifier, name }: { bundleIdentifier: string; name: string },
): void => {
  let debugFound = false;
  for (const { name: configuration, buildSettings } of configurations) {
    if (buildSettings['PRODUCT_BUNDLE_IDENTIFIER'] === undefined) {
      continue;
    }
    const isDebug = configuration === 'Debug';
    debugFound ||= isDebug;
    if (isDebug) {
      buildSettings['PRODUCT_BUNDLE_IDENTIFIER'] = `${bundleIdentifier}${DEV_ID_SUFFIX}`;
    }
    buildSettings[DISPLAY_NAME_SETTING] = JSON.stringify(isDebug ? devName(name) : name);
  }
  if (!debugFound) {
    throw new Error('dev-variant: the Xcode project has no Debug app-target configuration');
  }
};

const withDevVariant: ConfigPlugin = (config) => {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (bundleIdentifier === undefined) {
    throw new Error('dev-variant: app.json must set ios.bundleIdentifier');
  }
  const { name } = config;

  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyAndroidBuildTypes(mod.modResults.contents, name);
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    const [application] = mod.modResults.manifest.application ?? [];
    if (application === undefined) {
      throw new Error('dev-variant: AndroidManifest.xml has no application element');
    }
    application.$['android:label'] = `\${${LABEL_PLACEHOLDER}}`;
    return mod;
  });

  config = withInfoPlist(config, (mod) => {
    mod.modResults['CFBundleDisplayName'] = `$(${DISPLAY_NAME_SETTING})`;
    return mod;
  });

  return withXcodeProject(config, (mod) => {
    const section: Record<string, BuildConfiguration | string> =
      mod.modResults.pbxXCBuildConfigurationSection();
    applyIosBuildConfigurations(
      Object.values(section).filter((entry) => typeof entry === 'object'),
      { bundleIdentifier, name },
    );
    return mod;
  });
};

export default withDevVariant;

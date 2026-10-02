/**
 * A development build installs beside the release build instead of replacing it.
 *
 * The split is carried by the build type in the generated native projects, so these checks run the
 * plugin's transforms over the shapes Expo's templates produce: only the Android debug build type
 * and the iOS Debug app-target configuration move to the development identity.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEV_ID_SUFFIX,
  DISPLAY_NAME_SETTING,
  applyAndroidBuildTypes,
  applyIosBuildConfigurations,
} from '../plugins/dev-variant.ts';

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const GRADLE = `android {
    defaultConfig {
        applicationId 'studio.yourtechbud.raphael'
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

describe('Android build types', () => {
  it('labels the default build and gives the debug build type the development identity', () => {
    const gradle = applyAndroidBuildTypes(GRADLE, 'Raphael');
    assert.match(
      gradle,
      /defaultConfig \{\n {8}manifestPlaceholders\['appLabel'\] = 'Raphael'\n {8}applicationId/u,
    );
    assert.match(
      gradle,
      /debug \{\n {12}applicationIdSuffix '\.dev'\n {12}manifestPlaceholders\['appLabel'\] = 'Raphael Dev'\n {12}signingConfig/u,
    );
    assert.equal(gradle.match(/applicationIdSuffix/gu)?.length, 1);
  });

  it('quotes the label as a Groovy string', () => {
    assert.match(applyAndroidBuildTypes(GRADLE, "Raphael's"), /= 'Raphael\\'s Dev'/u);
  });

  it('is unchanged when applied again', () => {
    const once = applyAndroidBuildTypes(GRADLE, 'Raphael');
    assert.equal(applyAndroidBuildTypes(once, 'Raphael'), once);
  });

  it('fails loudly when the template no longer has the blocks it edits', () => {
    assert.throws(() => applyAndroidBuildTypes('android {}\n', 'Raphael'), /buildTypes\.debug/u);
  });

  it('launches the development identity from `pnpm android`', () => {
    // Expo launches the gradle `applicationId`, which has no suffix, so the script names the
    // development package itself and has to follow the package in app.json.
    const { expo } = readJson('../app.json');
    const { scripts } = readJson('../package.json');
    assert.match(
      scripts.android,
      new RegExp(`--app-id ${expo.android.package}${DEV_ID_SUFFIX}$`, 'u'),
    );
  });
});

describe('iOS build configurations', () => {
  const identity = { bundleIdentifier: 'studio.yourtechbud.raphael', name: 'Raphael' };
  const configurations = () => [
    { name: 'Debug', buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: identity.bundleIdentifier } },
    { name: 'Release', buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: identity.bundleIdentifier } },
    { name: 'Debug', buildSettings: { SDKROOT: 'iphoneos' } },
    { name: 'Release', buildSettings: { SDKROOT: 'iphoneos' } },
  ];

  it('moves only the Debug app target to the development identity', () => {
    const [debug, release, projectDebug, projectRelease] = configurations();
    applyIosBuildConfigurations([debug, release, projectDebug, projectRelease], identity);

    assert.equal(debug.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, 'studio.yourtechbud.raphael.dev');
    assert.equal(debug.buildSettings[DISPLAY_NAME_SETTING], '"Raphael Dev"');
    assert.equal(release.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, 'studio.yourtechbud.raphael');
    assert.equal(release.buildSettings[DISPLAY_NAME_SETTING], '"Raphael"');
    assert.deepEqual(projectDebug.buildSettings, { SDKROOT: 'iphoneos' });
    assert.deepEqual(projectRelease.buildSettings, { SDKROOT: 'iphoneos' });
  });

  it('fails loudly when there is no Debug app-target configuration', () => {
    const [, release] = configurations();
    assert.throws(() => applyIosBuildConfigurations([release], identity), /Debug/u);
  });
});
